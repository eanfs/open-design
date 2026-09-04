import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { IncomingMessage, RequestListener, Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { AuroraCommerceErrorSchema } from '@open-design/aurora-contracts';

import { createAuroraApp } from '../src/app.js';
import { withAuroraTransaction } from '../src/db.js';
import {
  applyAuroraTopup,
  createAuroraLedgerService,
  type LedgerService,
} from '../src/commerce/ledger.js';
import {
  createAuroraSessionStore,
  upsertAuroraAccount,
  type AuroraPrincipal,
  type AuroraSessionStore,
} from '../src/auth/session-store.js';
import type { AuroraConfig } from '../src/config.js';
import { runChargeReservationKey } from '../src/runs/admission.js';
import { createOpenDesignUpstream } from '../src/runs/upstream.js';
import {
  decisionForRunStatus,
  normalizeRunStatus,
  reconcileReservedCharges,
  reconcileRunCharge,
  startRunReconciliationScheduler,
} from '../src/runs/reconciler.js';

const SESSION_COOKIE = '__Host-aurora_session';
const RUN_PRICE_AMOUNT = '0.50';
const RUN_PRICING_VERSION = '2026-09';
const RUN_AGENT_ID = 'deepseek-harness';

function readRequestBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => (body += chunk));
  request.on('end', () => resolve(body));
  request.on('error', reject);
  return promise;
}

interface CapturedRunRequest {
  readonly path: string;
  readonly rawBody: string;
  readonly body: Record<string, unknown>;
}

/**
 * OpenDesign stand-in for the reconciliation suite. Beyond Task 6's
 * `POST /api/runs` createOrReuse contract it serves `GET /api/runs/:id`
 * run status for the poll cycle: every created run is retrievable with the
 * status last set by the test, or not found once removed. Creation can be
 * scripted to reject deterministically (any status) so admission's
 * deterministic-client-error release path is exercised over real HTTP.
 */
class FakeOpenDesignApi {
  readonly requests: CapturedRunRequest[] = [];
  private counter = 0;
  private readonly runsByClientRequestId = new Map<string, string>();
  private readonly statusByRunId = new Map<string, string>();
  private readonly createRejections = new Map<string, { status: number; body: object }>();
  private readonly unavailableStatusRunIds = new Set<string>();

  /** Script the POST /api/runs response for one clientRequestId. */
  rejectCreate(clientRequestId: string, status: number, body: object): void {
    this.createRejections.set(clientRequestId, { status, body });
  }

  /** Serve the given status from GET /api/runs/:id until changed. */
  setRunStatus(runId: string, status: string): void {
    this.statusByRunId.set(runId, status);
  }

  /** Destroy status responses so the poller sees an uncertain network. */
  armStatusUnavailable(runId: string): void {
    this.unavailableStatusRunIds.add(runId);
  }

  clearStatusUnavailable(runId: string): void {
    this.unavailableStatusRunIds.delete(runId);
  }

  /** Make GET /api/runs/:id answer 404 (the run no longer exists upstream). */
  removeRun(runId: string): void {
    this.statusByRunId.delete(runId);
    for (const [clientRequestId, existing] of this.runsByClientRequestId) {
      if (existing === runId) this.runsByClientRequestId.delete(clientRequestId);
    }
  }

  requestsFor(clientRequestId: string): CapturedRunRequest[] {
    return this.requests.filter((request) => request.body.clientRequestId === clientRequestId);
  }

  async start(): Promise<Server> {
    const listener: RequestListener = async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://opendesign.fake');
        const respond = (status: number, payload: object): void => {
          response.statusCode = status;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(payload));
        };
        if (url.pathname === '/api/runs' && request.method === 'POST') {
          const rawBody = await readRequestBody(request);
          const body = JSON.parse(rawBody) as Record<string, unknown>;
          const clientRequestId = String(body.clientRequestId);
          this.requests.push({ path: url.pathname, rawBody, body });
          const rejection = this.createRejections.get(clientRequestId);
          if (rejection !== undefined) {
            respond(rejection.status, rejection.body);
            return;
          }
          let runId = this.runsByClientRequestId.get(clientRequestId);
          const existingRunId = runId;
          if (runId === undefined) {
            this.counter += 1;
            runId = `run-${this.counter}`;
            this.runsByClientRequestId.set(clientRequestId, runId);
            this.statusByRunId.set(runId, 'running');
          }
          respond(202, {
            runId,
            clientRequestId,
            reused: existingRunId !== undefined,
          });
          return;
        }
        const statusMatch = /^\/api\/runs\/([^/]+)$/u.exec(url.pathname);
        if (statusMatch !== null && request.method === 'GET') {
          const runId = decodeURIComponent(statusMatch[1]!);
          if (this.unavailableStatusRunIds.has(runId)) {
            response.destroy();
            return;
          }
          if (!this.statusByRunId.has(runId)) {
            respond(404, { error: 'run_not_found' });
            return;
          }
          respond(200, { id: runId, status: this.statusByRunId.get(runId) });
          return;
        }
        respond(404, { error: 'not_found' });
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    };
    const server = createHttpServer(listener);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  }
}

async function reservePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function closeServer(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  return promise;
}

/**
 * Real-clock poll helper for the scheduler test only: the scheduler drives
 * its own platform `setInterval`, so deterministic fake timers would not
 * exercise the timer we are testing; the bounded poll just observes its
 * effect. Every other test in this file drives reconciliation directly.
 */
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 25);
    await promise;
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Aurora run settlement reconciliation', () => {
  let pool: Pool;
  let container: StartedPostgreSqlContainer;
  let fakeUpstream: FakeOpenDesignApi;
  let fakeUpstreamServer: Server;
  let ledger: LedgerService;
  let accountCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(120_000)
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    for (const file of [
      '001-auth.sql',
      '002-commerce.sql',
      '003-ledger.sql',
      '004-run-charges.sql',
    ]) {
      const migration = await readFile(
        new URL(`../src/migrations/${file}`, import.meta.url),
        'utf8',
      );
      await pool.query(migration);
    }
    ledger = createAuroraLedgerService(pool);
    fakeUpstream = new FakeOpenDesignApi();
    fakeUpstreamServer = await fakeUpstream.start();
  }, 120_000);

  afterAll(async () => {
    if (fakeUpstreamServer) await closeServer(fakeUpstreamServer);
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  async function provisionAccount(): Promise<{ accountId: string; cookie: string }> {
    accountCounter += 1;
    const principal = await upsertAuroraAccount(pool, {
      issuer: 'https://aurora-oidc.invalid',
      subject: `reconcile-user-${accountCounter}`,
      email: `reconcile-user-${accountCounter}@example.com`,
      displayName: `reconcile-user-${accountCounter}`,
    });
    const store = createAuroraSessionStore(pool, { ttlSeconds: 3600 });
    const nullTokens = {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    };
    const cookie = await store.create(principal, nullTokens);
    await withAuroraTransaction(pool, (client) =>
      applyAuroraTopup(client, principal.accountId, '10.00'),
    );
    return { accountId: principal.accountId, cookie };
  }

  async function seedReservedRunCharge(
    accountId: string,
    clientRequestId: string,
    runId: string | null,
  ): Promise<void> {
    const digest = createHash('sha256').update(clientRequestId, 'utf8').digest('hex');
    await pool.query(
      `INSERT INTO run_charges
         (account_id, client_request_id, pricing_version, amount, body_digest, state)
       VALUES ($1, $2, $3, $4, $5, 'reserved')`,
      [accountId, clientRequestId, RUN_PRICING_VERSION, RUN_PRICE_AMOUNT, digest],
    );
    await ledger.reserveCredits(
      accountId,
      runChargeReservationKey(accountId, clientRequestId),
      RUN_PRICE_AMOUNT,
    );
    if (runId !== null) {
      await pool.query(
        `UPDATE run_charges SET run_id = $1
         WHERE account_id = $2 AND client_request_id = $3`,
        [runId, accountId, clientRequestId],
      );
    }
  }

  async function loadCharge(
    accountId: string,
    clientRequestId: string,
  ): Promise<{
    state: string;
    run_id: string | null;
  } | null> {
    const result = await pool.query(
      `SELECT state, run_id FROM run_charges
       WHERE account_id = $1 AND client_request_id = $2`,
      [accountId, clientRequestId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { state: row.state as string, run_id: row.run_id };
  }

  async function walletOf(
    accountId: string,
  ): Promise<{ availableCredits: string; reservedCredits: string }> {
    const result = await pool.query<{
      available_credits: string;
      reserved_credits: string;
    }>('SELECT available_credits, reserved_credits FROM wallets WHERE account_id = $1', [
      accountId,
    ]);
    const row = result.rows[0];
    return {
      availableCredits: row?.available_credits ?? '0.00',
      reservedCredits: row?.reserved_credits ?? '0.00',
    };
  }

  async function ledgerEntryKinds(accountId: string): Promise<string[]> {
    const result = await pool.query<{ kind: string }>(
      'SELECT kind FROM ledger_entries WHERE account_id = $1 ORDER BY seq',
      [accountId],
    );
    return result.rows.map((row) => row.kind);
  }

  /**
   * Full-poll-cycle tests assert exact tallies, so they must not inherit
   * reserved charges left behind by earlier direct-reconcile tests (which
   * intentionally keep non-terminal charges reserved). Their own assertions
   * already ran, so clearing the leftovers is safe.
   */
  async function clearReservedRunCharges(): Promise<void> {
    await pool.query(`DELETE FROM run_charges WHERE state = 'reserved'`);
  }

  it('maps every canonical run status onto a settlement decision', () => {
    expect(decisionForRunStatus('succeeded')).toBe('settle');
    expect(decisionForRunStatus('failed')).toBe('release');
    expect(decisionForRunStatus('canceled')).toBe('release');
    expect(decisionForRunStatus('queued')).toBe('retry');
    expect(decisionForRunStatus('running')).toBe('retry');
  });

  it('normalizes upstream status spellings and rejects unknown values', () => {
    expect(normalizeRunStatus('starting')).toBe('running');
    expect(normalizeRunStatus('cancelled')).toBe('canceled');
    expect(normalizeRunStatus('queued')).toBe('queued');
    expect(normalizeRunStatus('succeeded')).toBe('succeeded');
    expect(normalizeRunStatus('wandering')).toBeNull();
  });

  it('settles a reserved charge whose run succeeded', async () => {
    const { accountId } = await provisionAccount();
    await seedReservedRunCharge(accountId, 'run-ok', 'run-ok');
    const charge = await loadCharge(accountId, 'run-ok');
    expect(charge).toMatchObject({ state: 'reserved', run_id: 'run-ok' });

    await reconcileRunCharge(pool, { accountId, clientRequestId: 'run-ok' }, {
      kind: 'status',
      status: 'succeeded',
    });

    expect(await loadCharge(accountId, 'run-ok')).toMatchObject({ state: 'settled' });
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.00',
    });
    // Settlement spends the reserved credits: one reservation, one settlement.
    expect(await ledgerEntryKinds(accountId)).toEqual(['topup', 'reservation', 'settlement']);
  });

  it('releases a reserved charge whose run failed or was canceled', async () => {
    const failed = await provisionAccount();
    await seedReservedRunCharge(failed.accountId, 'run-failed', 'run-failed');
    await reconcileRunCharge(pool, { accountId: failed.accountId, clientRequestId: 'run-failed' }, {
      kind: 'status',
      status: 'failed',
    });
    expect(await loadCharge(failed.accountId, 'run-failed')).toMatchObject({
      state: 'released',
    });
    expect(await walletOf(failed.accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });
    expect(await ledgerEntryKinds(failed.accountId)).toEqual(['topup', 'reservation', 'release']);

    const canceled = await provisionAccount();
    await seedReservedRunCharge(canceled.accountId, 'run-canceled', 'run-canceled');
    await reconcileRunCharge(
      pool,
      { accountId: canceled.accountId, clientRequestId: 'run-canceled' },
      { kind: 'status', status: 'canceled' },
    );
    expect(await loadCharge(canceled.accountId, 'run-canceled')).toMatchObject({
      state: 'released',
    });
    expect(await walletOf(canceled.accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });
  });

  it('keeps non-terminal runs reserved', async () => {
    for (const status of ['queued', 'running'] as const) {
      const { accountId } = await provisionAccount();
      await seedReservedRunCharge(accountId, `run-${status}`, `run-${status}`);
      const decision = await reconcileRunCharge(
        pool,
        { accountId, clientRequestId: `run-${status}` },
        { kind: 'status', status },
      );
      expect(decision).toBe('retry');
      expect(await loadCharge(accountId, `run-${status}`)).toMatchObject({
        state: 'reserved',
      });
      expect(await walletOf(accountId)).toEqual({
        availableCredits: '9.50',
        reservedCredits: '0.50',
      });
    }
  });

  it('keeps the reservation reserved while the upstream is unavailable', async () => {
    const { accountId } = await provisionAccount();
    await seedReservedRunCharge(accountId, 'run-wait', 'run-wait');
    await reconcileRunCharge(pool, { accountId, clientRequestId: 'run-wait' }, {
      kind: 'unavailable',
    });
    expect(await loadCharge(accountId, 'run-wait')).toMatchObject({ state: 'reserved' });
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.50',
    });
  });

  it('releases a reservation whose run no longer exists upstream', async () => {
    const { accountId } = await provisionAccount();
    await seedReservedRunCharge(accountId, 'run-gone', 'run-gone');
    await reconcileRunCharge(pool, { accountId, clientRequestId: 'run-gone' }, {
      kind: 'not-found',
    });
    expect(await loadCharge(accountId, 'run-gone')).toMatchObject({ state: 'released' });
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });
  });

  it('never settles or releases a terminal charge twice', async () => {
    const { accountId } = await provisionAccount();
    await seedReservedRunCharge(accountId, 'run-twice', 'run-twice');

    const first = await reconcileRunCharge(
      pool,
      { accountId, clientRequestId: 'run-twice' },
      { kind: 'status', status: 'succeeded' },
    );
    expect(first).toBe('settled');
    const second = await reconcileRunCharge(
      pool,
      { accountId, clientRequestId: 'run-twice' },
      { kind: 'status', status: 'succeeded' },
    );
    expect(second).toBe('unchanged');

    expect(await loadCharge(accountId, 'run-twice')).toMatchObject({ state: 'settled' });
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.00',
    });
    expect(await ledgerEntryKinds(accountId)).toEqual(['topup', 'reservation', 'settlement']);
  });

  it('settles and releases only charges that carry a run id, in one poll cycle', async () => {
    await clearReservedRunCharges();
    const succeeded = await provisionAccount();
    const running = await provisionAccount();
    const canceled = await provisionAccount();
    const gone = await provisionAccount();
    const runless = await provisionAccount();
    await seedReservedRunCharge(succeeded.accountId, 'cycle-ok', 'cycle-ok');
    await seedReservedRunCharge(running.accountId, 'cycle-run', 'cycle-run');
    await seedReservedRunCharge(canceled.accountId, 'cycle-cancel', 'cycle-cancel');
    await seedReservedRunCharge(gone.accountId, 'cycle-gone', 'cycle-gone');
    // A runless reservation has no status to poll; the cycle must leave it.
    await seedReservedRunCharge(runless.accountId, 'cycle-runless', null);

    fakeUpstream.setRunStatus('cycle-ok', 'succeeded');
    fakeUpstream.setRunStatus('cycle-run', 'running');
    fakeUpstream.setRunStatus('cycle-cancel', 'canceled');
    fakeUpstream.removeRun('cycle-gone');

    const summary = await reconcileReservedCharges({
      db: pool,
      upstream: createOpenDesignUpstream({
        baseUrl: `http://127.0.0.1:${(fakeUpstreamServer.address() as AddressInfo).port}`,
      }),
    });

    expect(summary).toEqual({ settled: 1, released: 2, retried: 1, failed: 0 });
    expect(await loadCharge(succeeded.accountId, 'cycle-ok')).toMatchObject({
      state: 'settled',
    });
    expect(await loadCharge(running.accountId, 'cycle-run')).toMatchObject({
      state: 'reserved',
    });
    expect(await loadCharge(canceled.accountId, 'cycle-cancel')).toMatchObject({
      state: 'released',
    });
    expect(await loadCharge(gone.accountId, 'cycle-gone')).toMatchObject({
      state: 'released',
    });
    expect(await loadCharge(runless.accountId, 'cycle-runless')).toMatchObject({
      state: 'reserved',
    });
  });

  it('retries a charge whose status fetch failed, then settles it once reachable', async () => {
    await clearReservedRunCharges();
    const { accountId } = await provisionAccount();
    await seedReservedRunCharge(accountId, 'recover-me', 'recover-me');
    fakeUpstream.armStatusUnavailable('recover-me');

    let summary = await reconcileReservedCharges({
      db: pool,
      upstream: createOpenDesignUpstream({
        baseUrl: `http://127.0.0.1:${(fakeUpstreamServer.address() as AddressInfo).port}`,
      }),
    });
    expect(summary).toEqual({ settled: 0, released: 0, retried: 1, failed: 0 });
    expect(await loadCharge(accountId, 'recover-me')).toMatchObject({ state: 'reserved' });
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.50',
    });

    fakeUpstream.clearStatusUnavailable('recover-me');
    fakeUpstream.setRunStatus('recover-me', 'succeeded');
    summary = await reconcileReservedCharges({
      db: pool,
      upstream: createOpenDesignUpstream({
        baseUrl: `http://127.0.0.1:${(fakeUpstreamServer.address() as AddressInfo).port}`,
      }),
    });
    expect(summary).toEqual({ settled: 1, released: 0, retried: 0, failed: 0 });
    expect(await loadCharge(accountId, 'recover-me')).toMatchObject({ state: 'settled' });
  });

  it('polls on a schedule until stopped', async () => {
    await clearReservedRunCharges();
    const { accountId } = await provisionAccount();
    await seedReservedRunCharge(accountId, 'scheduled', 'scheduled');
    fakeUpstream.setRunStatus('scheduled', 'succeeded');

    const scheduler = startRunReconciliationScheduler({
      db: pool,
      upstream: createOpenDesignUpstream({
        baseUrl: `http://127.0.0.1:${(fakeUpstreamServer.address() as AddressInfo).port}`,
      }),
      intervalMs: 30,
    });
    try {
      await waitUntil(async () => {
        const charge = await loadCharge(accountId, 'scheduled');
        return charge?.state === 'settled';
      });
      expect(await walletOf(accountId)).toEqual({
        availableCredits: '9.50',
        reservedCredits: '0.00',
      });
    } finally {
      scheduler.stop();
    }
  });
});

describe('Aurora run commerce error contract', () => {
  let pool: Pool;
  let container: StartedPostgreSqlContainer;
  let fakeUpstream: FakeOpenDesignApi;
  let fakeUpstreamServer: Server;
  let appServer: Server;
  let appOrigin: string;
  let config: AuroraConfig;
  let richAccount: AuroraPrincipal;
  let richCookie: string;
  let brokeAccount: AuroraPrincipal;
  let brokeCookie: string;
  let store: AuroraSessionStore;
  let accountCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(120_000)
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    for (const file of [
      '001-auth.sql',
      '002-commerce.sql',
      '003-ledger.sql',
      '004-run-charges.sql',
    ]) {
      const migration = await readFile(
        new URL(`../src/migrations/${file}`, import.meta.url),
        'utf8',
      );
      await pool.query(migration);
    }

    fakeUpstream = new FakeOpenDesignApi();
    fakeUpstreamServer = await fakeUpstream.start();
    const upstreamPort = (fakeUpstreamServer.address() as AddressInfo).port;

    const appPort = await reservePort();
    appOrigin = `http://127.0.0.1:${appPort}`;
    config = {
      host: '127.0.0.1',
      port: appPort,
      publicOrigin: appOrigin,
      oidc: {
        issuer: 'https://aurora-oidc.invalid',
        clientId: 'aurora-web',
        clientSecret: 'aurora-secret',
      },
      sessionTtlSeconds: 3600,
      loginStateTtlSeconds: 600,
      loginStateSigningSecret: 'test-signing-secret',
      stripe: {
        secretKey: 'sk_test_aurora',
        webhookSecret: 'whsec_test_aurora',
      },
      runs: {
        upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      },
    };
    appServer = createAuroraApp({ db: pool, config }).listen(config.port, config.host);
    await new Promise<void>((resolve) => appServer.once('listening', resolve));

    store = createAuroraSessionStore(pool, { ttlSeconds: config.sessionTtlSeconds });
    const nullTokens = {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    };
    const provision = async (subject: string): Promise<[AuroraPrincipal, string]> => {
      const principal = await upsertAuroraAccount(pool, {
        issuer: 'https://aurora-oidc.invalid',
        subject,
        email: `${subject}@example.com`,
        displayName: subject,
      });
      const cookie = await store.create(principal, nullTokens);
      return [principal, cookie];
    };
    [richAccount, richCookie] = await provision('error-user-1');
    [brokeAccount, brokeCookie] = await provision('error-user-2');
    await withAuroraTransaction(pool, (client) =>
      applyAuroraTopup(client, richAccount.accountId, '10.00'),
    );
  }, 120_000);

  afterAll(async () => {
    if (appServer) await closeServer(appServer);
    if (fakeUpstreamServer) await closeServer(fakeUpstreamServer);
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  function createPaidRun(
    body: unknown,
    cookie: string = richCookie,
    origin: string = appOrigin,
  ): Promise<Response> {
    return fetch(`${appOrigin}/api/aurora/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie: `${SESSION_COOKIE}=${cookie}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function expectCommerceError(
    response: Response,
    status: number,
    code: string,
  ): Promise<Record<string, unknown>> {
    expect(response.status).toBe(status);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(AuroraCommerceErrorSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({ status, code });
    return payload;
  }

  async function loadCharge(
    accountId: string,
    clientRequestId: string,
  ): Promise<{
    state: string;
    run_id: string | null;
  } | null> {
    const result = await pool.query(
      `SELECT state, run_id FROM run_charges
       WHERE account_id = $1 AND client_request_id = $2`,
      [accountId, clientRequestId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { state: row.state as string, run_id: row.run_id };
  }

  async function walletOf(
    accountId: string,
  ): Promise<{ availableCredits: string; reservedCredits: string }> {
    const result = await pool.query<{
      available_credits: string;
      reserved_credits: string;
    }>('SELECT available_credits, reserved_credits FROM wallets WHERE account_id = $1', [
      accountId,
    ]);
    const row = result.rows[0];
    return {
      availableCredits: row?.available_credits ?? '0.00',
      reservedCredits: row?.reserved_credits ?? '0.00',
    };
  }

  /**
   * Fresh account with a 10.00 wallet per scenario, so wallet assertions are
   * local to one test instead of depending on earlier tests' cumulative
   * spend.
   */
  async function provisionAccount(): Promise<{ accountId: string; cookie: string }> {
    accountCounter += 1;
    const principal = await upsertAuroraAccount(pool, {
      issuer: 'https://aurora-oidc.invalid',
      subject: `error-user-scenario-${accountCounter}`,
      email: `error-user-scenario-${accountCounter}@example.com`,
      displayName: `error-user-scenario-${accountCounter}`,
    });
    const nullTokens = {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    };
    const cookie = await store.create(principal, nullTokens);
    await withAuroraTransaction(pool, (client) =>
      applyAuroraTopup(client, principal.accountId, '10.00'),
    );
    return { accountId: principal.accountId, cookie };
  }

  it('returns schema-valid commerce errors for 401, 402, and 409 admission rejections', async () => {
    const unauthenticated = await fetch(`${appOrigin}/api/aurora/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: appOrigin },
      body: JSON.stringify({ clientRequestId: 'req-anon', message: 'anon' }),
    });
    await expectCommerceError(unauthenticated, 401, 'aurora_unauthenticated');

    const broke = await createPaidRun(
      { clientRequestId: 'req-broke', message: 'broke', currentPrompt: 'broke' },
      brokeCookie,
    );
    await expectCommerceError(broke, 402, 'aurora_insufficient_credits');

    const missingId = await createPaidRun({ message: 'no id', currentPrompt: 'no id' });
    await expectCommerceError(missingId, 409, 'aurora_run_request_invalid');

    const wrongAgent = await createPaidRun({
      clientRequestId: 'req-agent',
      agentId: 'claude',
      message: 'claude',
      currentPrompt: 'claude',
    });
    await expectCommerceError(wrongAgent, 409, 'aurora_agent_not_supported');
  });

  it('releases the reservation immediately on a deterministic upstream 4xx and never re-charges a replay', async () => {
    const { accountId, cookie } = await provisionAccount();
    const body = {
      clientRequestId: 'req-deterministic',
      message: 'This body will be rejected',
      currentPrompt: 'This body will be rejected',
    };
    fakeUpstream.rejectCreate('req-deterministic', 400, {
      error: 'body_rejected',
      message: 'the message is not acceptable',
    });

    const first = await createPaidRun(body, cookie);
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({
      error: 'body_rejected',
      message: 'the message is not acceptable',
    });
    expect(await loadCharge(accountId, 'req-deterministic')).toMatchObject({
      state: 'released',
      run_id: null,
    });
    // The release refunds the reservation: the wallet is untouched overall.
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });

    // Identical replay: the released identity must not re-reserve, re-contact
    // the upstream, or re-charge the wallet.
    const upstreamCount = fakeUpstream.requests.length;
    const replay = await createPaidRun(body, cookie);
    await expectCommerceError(replay, 409, 'aurora_run_request_closed');
    expect(fakeUpstream.requests.length).toBe(upstreamCount);
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });
  });

  it('forwards an upstream 409 conflict body verbatim instead of reinterpreting it', async () => {
    // The upstream's own 409 shares a status code with the Aurora commerce
    // conflict error but is not one: the route must pass the upstream body
    // through untouched rather than parse it as an AuroraCommerceError.
    const { accountId, cookie } = await provisionAccount();
    const body = {
      clientRequestId: 'req-upstream-conflict',
      message: 'conflicts upstream',
      currentPrompt: 'conflicts upstream',
    };
    fakeUpstream.rejectCreate('req-upstream-conflict', 409, {
      error: 'client_request_id_conflict',
      detail: 'already bound to a different body',
    });

    const response = await createPaidRun(body, cookie);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'client_request_id_conflict',
      detail: 'already bound to a different body',
    });
    // Deterministic rejection: released and refunded, never left reserved.
    expect(await loadCharge(accountId, 'req-upstream-conflict')).toMatchObject({
      state: 'released',
      run_id: null,
    });
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });

    const upstreamCount = fakeUpstream.requests.length;
    const replay = await createPaidRun(body, cookie);
    await expectCommerceError(replay, 409, 'aurora_run_request_closed');
    expect(fakeUpstream.requests.length).toBe(upstreamCount);
  });

  it('treats 422 as deterministic but keeps 429 and 503 reserved for reconciliation', async () => {
    const { accountId, cookie } = await provisionAccount();
    const body422 = {
      clientRequestId: 'req-422',
      message: 'unprocessable',
      currentPrompt: 'unprocessable',
    };
    fakeUpstream.rejectCreate('req-422', 422, { error: 'unprocessable_entity' });
    const response422 = await createPaidRun(body422, cookie);
    expect(response422.status).toBe(422);
    expect(await loadCharge(accountId, 'req-422')).toMatchObject({
      state: 'released',
    });
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });

    const body429 = {
      clientRequestId: 'req-429',
      message: 'throttled',
      currentPrompt: 'throttled',
    };
    fakeUpstream.rejectCreate('req-429', 429, { error: 'too_many_requests' });
    const response429 = await createPaidRun(body429, cookie);
    expect(response429.status).toBe(429);
    expect(await loadCharge(accountId, 'req-429')).toMatchObject({
      state: 'reserved',
    });
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.50',
    });

    const body503 = {
      clientRequestId: 'req-503',
      message: 'unavailable',
      currentPrompt: 'unavailable',
    };
    fakeUpstream.rejectCreate('req-503', 503, { error: 'upstream_down' });
    const response503 = await createPaidRun(body503, cookie);
    expect(response503.status).toBe(503);
    expect(await loadCharge(accountId, 'req-503')).toMatchObject({
      state: 'reserved',
    });
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '9.00',
      reservedCredits: '1.00',
    });
  });

  it('reconciles an admitted run to settled and replays its identity without re-charging', async () => {
    const { accountId, cookie } = await provisionAccount();
    const body = {
      clientRequestId: 'req-full-loop',
      message: 'Design a poster',
      currentPrompt: 'Design a poster',
    };
    const created = await createPaidRun(body, cookie);
    expect(created.status).toBe(201);
    const { runId } = (await created.json()) as { runId: string };
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.50',
    });

    fakeUpstream.setRunStatus(runId, 'succeeded');
    const summary = await reconcileReservedCharges({
      db: pool,
      upstream: createOpenDesignUpstream({
        baseUrl: `http://127.0.0.1:${(fakeUpstreamServer.address() as AddressInfo).port}`,
      }),
    });
    expect(summary).toEqual({ settled: 1, released: 0, retried: 0, failed: 0 });
    expect(await loadCharge(accountId, 'req-full-loop')).toMatchObject({
      state: 'settled',
      run_id: runId,
    });
    // Settlement spends the reserved credits: 0.50 gone from the wallet.
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.00',
    });

    const upstreamCount = fakeUpstream.requests.length;
    const replay = await createPaidRun(body, cookie);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { runId: string }).runId).toBe(runId);
    expect(fakeUpstream.requests.length).toBe(upstreamCount);
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.00',
    });
  });

  it('releases an admitted run that failed and replays its released identity safely', async () => {
    const { accountId, cookie } = await provisionAccount();
    const body = {
      clientRequestId: 'req-failed-run',
      message: 'A run that fails',
      currentPrompt: 'A run that fails',
    };
    const created = await createPaidRun(body, cookie);
    expect(created.status).toBe(201);
    const { runId } = (await created.json()) as { runId: string };

    fakeUpstream.setRunStatus(runId, 'failed');
    const summary = await reconcileReservedCharges({
      db: pool,
      upstream: createOpenDesignUpstream({
        baseUrl: `http://127.0.0.1:${(fakeUpstreamServer.address() as AddressInfo).port}`,
      }),
    });
    expect(summary).toEqual({ settled: 0, released: 1, retried: 0, failed: 0 });
    expect(await loadCharge(accountId, 'req-failed-run')).toMatchObject({
      state: 'released',
      run_id: runId,
    });
    // The release refunds the 0.50 reservation.
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });

    const upstreamCount = fakeUpstream.requests.length;
    const replay = await createPaidRun(body, cookie);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { runId: string }).runId).toBe(runId);
    expect(fakeUpstream.requests.length).toBe(upstreamCount);
    expect(await walletOf(accountId)).toEqual({
      availableCredits: '10.00',
      reservedCredits: '0.00',
    });
  });
});
