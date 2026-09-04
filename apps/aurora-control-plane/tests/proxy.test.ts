import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createOpenDesignProxy } from '../src/proxy/open-design.js';
import type { AuroraDatabase } from '../src/db.js';
import type { AuroraConfig } from '../src/config.js';
import type { TenantRouteStore } from '../src/tenants/routes.js';

const TEST_CONFIG: AuroraConfig = {
  host: '127.0.0.1',
  port: 0,
  publicOrigin: 'http://127.0.0.1:0',
  oidc: { issuer: 'https://issuer.invalid', clientId: 'web', clientSecret: 'secret' },
  sessionTtlSeconds: 3600,
  loginStateTtlSeconds: 600,
  loginStateSigningSecret: 'signing-secret',
  stripe: { secretKey: 'sk_test', webhookSecret: 'whsec' },
};

const SESSION_COOKIE = '__Host-aurora_session';

/**
 * A db whose session lookup returns a valid principal for any token, so the
 * proxy middleware under test reaches the tenant-route step.
 */
function sessionAwareDb(): AuroraDatabase {
  const query = vi.fn(async (text: string) => {
    if (text.includes('FROM auth_sessions')) {
      return { rows: [{ account_id: 'acct_1', tenant_id: 't_1' }] };
    }
    return { rows: [] };
  });
  return { query } as unknown as AuroraDatabase;
}

function createRequest(overrides: Partial<Request> = {}): Request {
  return {
    path: '/api/agents',
    method: 'GET',
    headers: { cookie: `${SESSION_COOKIE}=session-token` },
    ...overrides,
  } as unknown as Request;
}

function createResponse(): Response {
  const response = {
    headersSent: false,
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    destroy() {},
  };
  return response as unknown as Response;
}

describe('createOpenDesignProxy', () => {
  it('fails closed when tenant route resolution throws', async () => {
    const tenants = {
      getByTenantId: vi.fn().mockRejectedValue(new Error('route store exploded')),
    } as unknown as TenantRouteStore;
    const proxy = createOpenDesignProxy({ db: sessionAwareDb(), config: TEST_CONFIG, tenants });

    const request = createRequest();
    const response = createResponse();
    const next = vi.fn();
    await proxy(request, response, next);

    // The error is forwarded to the Express error handler (500), and no
    // partial response was written to the client.
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((next.mock.calls[0]![0] as Error).message).toBe('route store exploded');
    expect(response.statusCode).toBe(0);
  });

  it('fails closed when session resolution throws', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error('db unreachable')),
    } as unknown as AuroraDatabase;
    const tenants = { getByTenantId: vi.fn() } as unknown as TenantRouteStore;
    const proxy = createOpenDesignProxy({ db, config: TEST_CONFIG, tenants });

    const request = createRequest();
    const response = createResponse();
    const next = vi.fn();
    await proxy(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect((next.mock.calls[0]![0] as Error).message).toBe('db unreachable');
  });
});
