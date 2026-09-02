import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  createAuroraApp,
  startAuroraServer,
  withAuroraTransaction,
  type AuroraAppDeps,
} from '../src/server.js';
import type { AuroraConfig } from '../src/config.js';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error != null) reject(error);
      else resolve();
    });
  });
}

function createFakeDatabase(options?: {
  failures?: Readonly<Record<string, Error>>;
}): {
  client: PoolClient;
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (text: string) => {
    const failure = options?.failures?.[text];
    if (failure != null) throw failure;
    return { rows: [] };
  });
  const release = vi.fn();
  const client = {
    query,
    release,
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;

  return { client, pool, query, release };
}

function createTestAuroraConfig(): AuroraConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:0',
    oidc: { issuer: 'https://issuer.example.com', clientId: 'aurora-web', clientSecret: 'secret' },
    sessionTtlSeconds: 3600,
    loginStateTtlSeconds: 600,
    loginStateSigningSecret: 'test-signing-secret',
  };
}

describe('Aurora control-plane app', () => {
  it('constructs an Express app only from explicit dependencies', () => {
    const { pool } = createFakeDatabase();
    const deps = {
      db: pool,
      config: createTestAuroraConfig(),
    } satisfies AuroraAppDeps;

    const app = createAuroraApp(deps);

    expect(app).toBeTypeOf('function');
    expect(app.listen).toBeTypeOf('function');
  });

  it('serves the internal health probe through a real temporary listener', async () => {
    const { pool } = createFakeDatabase();
    const server = await startAuroraServer({
      db: pool,
      config: createTestAuroraConfig(),
    });

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/aurora/health`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await closeServer(server);
    }
  });
});

describe('withAuroraTransaction', () => {
  it('begins, commits, returns the operation result, and releases the client', async () => {
    const { client, pool, query, release } = createFakeDatabase();
    const operation = vi.fn(async (transactionClient: PoolClient) => {
      expect(transactionClient).toBe(client);
      return { id: 'result-1' };
    });

    await expect(withAuroraTransaction(pool, operation)).resolves.toEqual({ id: 'result-1' });
    expect(operation).toHaveBeenCalledOnce();
    expect(query.mock.calls).toEqual([['BEGIN'], ['COMMIT']]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back the failed operation and always releases the client', async () => {
    const { pool, query, release } = createFakeDatabase();
    const failure = new Error('operation failed');

    await expect(
      withAuroraTransaction(pool, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(query.mock.calls).toEqual([['BEGIN'], ['ROLLBACK']]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back a failed commit and releases the client', async () => {
    const failure = new Error('commit failed');
    const { pool, query, release } = createFakeDatabase({
      failures: { COMMIT: failure },
    });

    await expect(withAuroraTransaction(pool, async () => 'result')).rejects.toBe(failure);

    expect(query.mock.calls).toEqual([['BEGIN'], ['COMMIT'], ['ROLLBACK']]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('preserves operation and rollback errors and releases the client exactly once', async () => {
    const operationFailure = new Error('operation failed');
    const rollbackFailure = new Error('rollback failed');
    const { pool, query, release } = createFakeDatabase({
      failures: { ROLLBACK: rollbackFailure },
    });

    let caught: unknown;
    try {
      await withAuroraTransaction(pool, async () => {
        throw operationFailure;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([operationFailure, rollbackFailure]);
    expect((caught as AggregateError).cause).toBe(operationFailure);
    expect(query.mock.calls).toEqual([['BEGIN'], ['ROLLBACK']]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('preserves commit and rollback errors and releases the client exactly once', async () => {
    const commitFailure = new Error('commit failed');
    const rollbackFailure = new Error('rollback failed');
    const { pool, query, release } = createFakeDatabase({
      failures: { COMMIT: commitFailure, ROLLBACK: rollbackFailure },
    });

    let caught: unknown;
    try {
      await withAuroraTransaction(pool, async () => 'result');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([commitFailure, rollbackFailure]);
    expect((caught as AggregateError).cause).toBe(commitFailure);
    expect(query.mock.calls).toEqual([['BEGIN'], ['COMMIT'], ['ROLLBACK']]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not run the operation or rollback after BEGIN fails and releases exactly once', async () => {
    const beginFailure = new Error('begin failed');
    const { pool, query, release } = createFakeDatabase({
      failures: { BEGIN: beginFailure },
    });
    const operation = vi.fn(async () => 'result');

    await expect(withAuroraTransaction(pool, operation)).rejects.toBe(beginFailure);

    expect(operation).not.toHaveBeenCalled();
    expect(query.mock.calls).toEqual([['BEGIN']]);
    expect(release).toHaveBeenCalledOnce();
  });
});
