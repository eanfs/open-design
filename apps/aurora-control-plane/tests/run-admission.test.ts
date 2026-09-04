import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { IncomingMessage, RequestListener, Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createAuroraApp } from '../src/app.js';
import { withAuroraTransaction } from '../src/db.js';
import { applyAuroraTopup } from '../src/commerce/ledger.js';
import {
  createAuroraSessionStore,
  upsertAuroraAccount,
  type AuroraPrincipal,
} from '../src/auth/session-store.js';
import type { AuroraConfig } from '../src/config.js';

const SESSION_COOKIE = '__Host-aurora_session';
const RUN_PRICE_AMOUNT = '0.50';
const RUN_PRICING_VERSION = '2026-09';

// The fixed run price is server-owned configuration; these literals pin the
// versioned price the admission route must charge for every run shape.
// Browser input never carries any of these values.

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
 * Minimal OpenDesign stand-in modeled on its `POST /api/runs` contract:
 * `createOrReuse` semantics keyed by `clientRequestId`, so a lost-response
 * retry recovers the same run instead of creating a new one. Bodies are
 * captured verbatim so tests can assert byte-identical replays. Armed drops
 * destroy the connection after the request was received, exactly like a
 * response lost on an uncertain network.
 */
class FakeOpenDesignApi {
  readonly requests: CapturedRunRequest[] = [];
  private counter = 0;
  private dropNextResponses = 0;
  private readonly runsByClientRequestId = new Map<string, string>();

  armLostResponses(count: number): void {
    this.dropNextResponses = count;
  }

  requestsFor(clientRequestId: string): CapturedRunRequest[] {
    return this.requests.filter(
      (request) => request.body.clientRequestId === clientRequestId,
    );
  }

  async start(): Promise<Server> {
    const listener: RequestListener = async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://opendesign.fake');
        const rawBody = await readRequestBody(request);
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        const clientRequestId = String(body.clientRequestId);
        this.requests.push({ path: url.pathname, rawBody, body });
        const respond = (status: number, payload: object): void => {
          response.statusCode = status;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(payload));
        };
        if (url.pathname !== '/api/runs') {
          respond(404, { error: 'not_found' });
          return;
        }
        // createOrReuse runs before the response can be lost: a dropped
        // response still leaves the run created upstream, so the next
        // identical request recovers the same run with `reused: true`.
        const existingRunId = this.runsByClientRequestId.get(clientRequestId);
        let runId = existingRunId;
        if (runId === undefined) {
          this.counter += 1;
          runId = `run-${this.counter}`;
          this.runsByClientRequestId.set(clientRequestId, runId);
        }
        if (this.dropNextResponses > 0) {
          this.dropNextResponses -= 1;
          response.destroy();
          return;
        }
        respond(202, {
          runId,
          conversationId: `conv-${runId}`,
          assistantMessageId: `assistant-${runId}`,
          clientRequestId,
          reused: existingRunId !== undefined,
          resumed: false,
        });
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

describe('Aurora paid run admission', () => {
  let pool: Pool;
  let container: StartedPostgreSqlContainer;
  let fakeUpstream: FakeOpenDesignApi;
  let fakeUpstreamServer: Server;
  let appServer: Server;
  let appOrigin: string;
  let config: AuroraConfig;
  let richAccount: AuroraPrincipal;
  let brokeAccount: AuroraPrincipal;
  let otherAccount: AuroraPrincipal;
  let richCookie: string;
  let brokeCookie: string;
  let otherCookie: string;
  let admittedRunId: string;
  let store: ReturnType<typeof createAuroraSessionStore>;

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
      '005-tenant-routes.sql',
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
      // Each account's tenant is routed to the shared fake OpenDesign
      // upstream; the browser never supplies this mapping.
      await pool.query(
        'INSERT INTO tenant_routes (tenant_id, upstream_origin) VALUES ($1, $2)',
        [principal.tenantId, `http://127.0.0.1:${upstreamPort}`],
      );
      const cookie = await store.create(principal, nullTokens);
      return [principal, cookie];
    };
    [richAccount, richCookie] = await provision('run-user-1');
    [brokeAccount, brokeCookie] = await provision('run-user-2');
    [otherAccount, otherCookie] = await provision('run-user-3');
    await withAuroraTransaction(pool, (client) =>
      applyAuroraTopup(client, richAccount.accountId, '10.00'),
    );
    await withAuroraTransaction(pool, (client) =>
      applyAuroraTopup(client, otherAccount.accountId, '10.00'),
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

  async function runCharge(
    accountId: string,
    clientRequestId: string,
  ): Promise<
    | {
        pricing_version: string;
        amount: string;
        body_digest: string;
        state: string;
        run_id: string | null;
      }
    | undefined
  > {
    const result = await pool.query(
      `SELECT pricing_version, amount, body_digest, state, run_id
       FROM run_charges WHERE account_id = $1 AND client_request_id = $2`,
      [accountId, clientRequestId],
    );
    return result.rows[0];
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

  it('admits a paid run without agentId or skills at the fixed price', async () => {
    const response = await createPaidRun({
      clientRequestId: 'req-1',
      message: 'Design a poster',
      currentPrompt: 'Design a poster',
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      runId: string;
      clientRequestId: string;
    };
    expect(payload.runId).toMatch(/^run-/u);
    expect(payload.clientRequestId).toBe('req-1');
    admittedRunId = payload.runId;

    const [upstream] = fakeUpstream.requestsFor('req-1');
    expect(upstream!.body).toMatchObject({
      clientRequestId: 'req-1',
      message: 'Design a poster',
      currentPrompt: 'Design a poster',
    });
    // No agent is injected: an omitted agentId stays omitted so the tenant's
    // OpenDesign instance picks its own provider.
    expect(upstream!.body).not.toHaveProperty('agentId');

    const charge = await runCharge(richAccount.accountId, 'req-1');
    expect(charge).toMatchObject({
      pricing_version: RUN_PRICING_VERSION,
      amount: RUN_PRICE_AMOUNT,
      state: 'reserved',
      run_id: payload.runId,
    });
    expect(charge!.body_digest).toBe(
      createHash('sha256').update(upstream!.rawBody).digest('hex'),
    );

    expect(await walletOf(richAccount.accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.50',
    });
  });

  it('replays the same run id for an identical retry without re-reserving', async () => {
    const upstreamCount = fakeUpstream.requests.length;
    const response = await createPaidRun({
      clientRequestId: 'req-1',
      message: 'Design a poster',
      currentPrompt: 'Design a poster',
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { runId: string };
    expect(payload.runId).toBe(admittedRunId);
    expect(fakeUpstream.requests.length).toBe(upstreamCount);
    expect(await walletOf(richAccount.accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.50',
    });
  });

  it('passes zero, one, and many skills through unchanged without injecting an agent', async () => {
    const oneSkill = await createPaidRun({
      clientRequestId: 'req-skill-1',
      skillId: 'poster-kit',
      message: 'one',
      currentPrompt: 'one',
    });
    expect(oneSkill.status).toBe(201);
    const manySkills = await createPaidRun({
      clientRequestId: 'req-skill-3',
      skillIds: ['poster-kit', 'slide-kit', 'icon-kit'],
      message: 'many',
      currentPrompt: 'many',
    });
    expect(manySkills.status).toBe(201);

    const [oneSkillUpstream] = fakeUpstream.requestsFor('req-skill-1');
    expect(oneSkillUpstream!.body).toMatchObject({ skillId: 'poster-kit' });
    expect(oneSkillUpstream!.body).not.toHaveProperty('agentId');
    const [manySkillsUpstream] = fakeUpstream.requestsFor('req-skill-3');
    expect(manySkillsUpstream!.body).toMatchObject({
      skillIds: ['poster-kit', 'slide-kit', 'icon-kit'],
    });
    expect(manySkillsUpstream!.body).not.toHaveProperty('agentId');
  });

  it('passes an explicit non-DSH agentId through unchanged (multi-provider)', async () => {
    const response = await createPaidRun({
      clientRequestId: 'req-claude',
      agentId: 'claude',
      message: 'claude',
      currentPrompt: 'claude',
    });
    expect(response.status).toBe(201);
    const [upstream] = fakeUpstream.requestsFor('req-claude');
    expect(upstream!.body).toMatchObject({ agentId: 'claude', message: 'claude' });
    expect(await runCharge(richAccount.accountId, 'req-claude')).toBeDefined();
  });
  it('rejects a missing, empty, or non-string clientRequestId before reserving', async () => {
    const upstreamCount = fakeUpstream.requests.length;
    for (const body of [
      { message: 'no id' },
      { clientRequestId: '', message: 'empty id' },
      { clientRequestId: 42, message: 'non-string id' },
    ]) {
      const response = await createPaidRun(body);
      expect(response.status).toBe(409);
      const payload = (await response.json()) as { code: string; status: number };
      expect(payload).toMatchObject({ code: 'aurora_run_request_invalid', status: 409 });
    }
    expect(fakeUpstream.requests.length).toBe(upstreamCount);
    expect(await walletOf(richAccount.accountId)).toEqual({
      availableCredits: '8.00',
      reservedCredits: '2.00',
    });
  });

  it('rejects a duplicate clientRequestId whose body digest differs', async () => {
    const upstreamCount = fakeUpstream.requests.length;
    const response = await createPaidRun({
      clientRequestId: 'req-1',
      message: 'A DIFFERENT logical request',
      currentPrompt: 'A DIFFERENT logical request',
    });
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { code: string; status: number };
    expect(fakeUpstream.requests.length).toBe(upstreamCount);
    expect(await walletOf(richAccount.accountId)).toEqual({
      availableCredits: '8.00',
      reservedCredits: '2.00',
    });
  });

  it('maps an insufficient balance to the ledger 402', async () => {
    const upstreamCount = fakeUpstream.requests.length;
    const response = await createPaidRun(
      { clientRequestId: 'req-broke', message: 'broke', currentPrompt: 'broke' },
      brokeCookie,
    );
    expect(response.status).toBe(402);
    const payload = (await response.json()) as { code: string; status: number };
    expect(payload).toMatchObject({ code: 'aurora_insufficient_credits', status: 402 });
    expect(await runCharge(brokeAccount.accountId, 'req-broke')).toBeUndefined();
    expect(fakeUpstream.requests.length).toBe(upstreamCount);
  });

  it('keeps the reservation when the upstream response is lost and recovers on an identical retry', async () => {
    const body = {
      clientRequestId: 'req-lost',
      message: 'Lost response run',
      currentPrompt: 'Lost response run',
    };
    // Two losses exhaust the initial attempt plus its single lost-response
    // retry; the reservation must survive both.
    fakeUpstream.armLostResponses(2);
    const first = await createPaidRun(body);
    expect(first.status).toBe(502);
    const lostCharge = await runCharge(richAccount.accountId, 'req-lost');
    expect(lostCharge).toMatchObject({ state: 'reserved', run_id: null });
    expect(await walletOf(richAccount.accountId)).toEqual({
      availableCredits: '7.50',
      reservedCredits: '2.50',
    });

    const retry = await createPaidRun(body);
    expect(retry.status).toBe(201);
    const payload = (await retry.json()) as { runId: string; reused: boolean };
    const attempts = fakeUpstream.requestsFor('req-lost');
    expect(attempts.length).toBe(3);
    expect(new Set(attempts.map((attempt) => attempt.rawBody)).size).toBe(1);
    expect(attempts.every((attempt) => attempt.body.clientRequestId === 'req-lost')).toBe(
      true,
    );
    // The retry body stays byte-identical and carries no injected agent.
    expect(attempts[2]!.body).not.toHaveProperty('agentId');
    const recoveredCharge = await runCharge(richAccount.accountId, 'req-lost');
    expect(recoveredCharge!.run_id).toBe(payload.runId);
    expect(payload.reused).toBe(true);
  });

  it('repairs a run charge whose credit reservation never landed (crash window)', async () => {
    // Dedicated account so the wallet assertions do not depend on the credit
    // spend of earlier tests in this file.
    const orphanPrincipal = await upsertAuroraAccount(pool, {
      issuer: 'https://aurora-oidc.invalid',
      subject: 'run-user-orphan',
      email: 'run-user-orphan@example.com',
      displayName: 'run-user-orphan',
    });
    await pool.query('INSERT INTO tenant_routes (tenant_id, upstream_origin) VALUES ($1, $2)', [
      orphanPrincipal.tenantId,
      `http://127.0.0.1:${(fakeUpstreamServer.address() as AddressInfo).port}`,
    ]);
    const nullTokens = {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    };
    const orphanCookie = await store.create(orphanPrincipal, nullTokens);
    await withAuroraTransaction(pool, (client) =>
      applyAuroraTopup(client, orphanPrincipal.accountId, '10.00'),
    );

    const body = {
      clientRequestId: 'req-orphan',
      message: 'Run after a crash',
      currentPrompt: 'Run after a crash',
    };
    // Simulate the crash window between the RunCharge commit and the ledger
    // reservation: insert the charge row by hand and never reserve credits.
    const outgoingDigest = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    await pool.query(
      `INSERT INTO run_charges
         (account_id, client_request_id, pricing_version, amount, body_digest, state)
       VALUES ($1, $2, $3, $4, $5, 'reserved')`,
      [orphanPrincipal.accountId, body.clientRequestId, RUN_PRICING_VERSION, RUN_PRICE_AMOUNT, outgoingDigest],
    );

    const response = await createPaidRun(body, orphanCookie);
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { runId: string };
    expect(payload.runId).toMatch(/^run-/u);

    // The missing reservation must be backfilled before the upstream call.
    const reservation = await pool.query(
      `SELECT 1 FROM ledger_entries
       WHERE reservation_key = $1 AND kind = 'reservation'`,
      [`run-charge:${orphanPrincipal.accountId}:${body.clientRequestId}`],
    );
    expect(reservation.rowCount).toBe(1);
    expect(await walletOf(orphanPrincipal.accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.50',
    });
    const charge = await runCharge(orphanPrincipal.accountId, body.clientRequestId);
    expect(charge!.run_id).toBe(payload.runId);
    expect(fakeUpstream.requestsFor(body.clientRequestId).length).toBe(1);
  });

  it('isolates clientRequestId idempotency per account', async () => {
    const response = await createPaidRun(
      {
        clientRequestId: 'req-1',
        message: 'Design a poster',
        currentPrompt: 'Design a poster',
      },
      otherCookie,
    );
    expect(response.status).toBe(201);
    const rows = await pool.query<{ account_id: string }>(
      'SELECT account_id FROM run_charges WHERE client_request_id = $1',
      ['req-1'],
    );
    expect(rows.rows.map((row) => row.account_id).sort()).toEqual(
      [otherAccount.accountId, richAccount.accountId].sort(),
    );
    expect(await walletOf(otherAccount.accountId)).toEqual({
      availableCredits: '9.50',
      reservedCredits: '0.50',
    });
  });
});
