import { readFile } from 'node:fs/promises';
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

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly rawBody: string;
  readonly body: Record<string, unknown> | undefined;
  readonly cookieHeader: string | undefined;
}

/**
 * Minimal isolated OpenDesign tenant stand-in. Each tenant serves its own
 * multi-provider agent list, its own project data, and its own run identity
 * space, so the gateway test can prove the proxy reaches the right instance
 * and never leaks one tenant's data or providers into another.
 */
class FakeOpenDesignTenant {
  readonly requests: CapturedRequest[] = [];
  readonly projects = new Map<string, Record<string, unknown>>();
  private runCounter = 0;
  private readonly runsByClientRequestId = new Map<string, string>();

  constructor(
    readonly name: string,
    readonly agentIds: readonly string[],
  ) {}

  async start(): Promise<Server> {
    const listener: RequestListener = async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://tenant.fake');
        const method = request.method ?? 'GET';
        let rawBody = '';
        request.setEncoding('utf8');
        for await (const chunk of request) rawBody += chunk;
        const body = rawBody === '' ? undefined : (JSON.parse(rawBody) as Record<string, unknown>);
        this.requests.push({
          method,
          path: url.pathname,
          rawBody,
          body,
          cookieHeader: request.headers.cookie,
        });

        const respond = (status: number, payload: unknown, headers?: Record<string, string>): void => {
          response.statusCode = status;
          response.setHeader('content-type', 'application/json');
          for (const [name, value] of Object.entries(headers ?? {})) {
            response.setHeader(name, value);
          }
          response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
        };

        if (url.pathname === '/api/health') {
          // A tenant may issue its own cookies; the gateway must not let them
          // land on the shared gateway origin.
          respond(200, { ok: true, tenant: this.name }, { 'Set-Cookie': 'tenant_auth=x; Path=/' });
          return;
        }
        if (url.pathname === '/api/agents') {
          respond(200, { agents: [...this.agentIds] });
          return;
        }
        if (url.pathname.startsWith('/api/projects/')) {
          const projectId = url.pathname.slice('/api/projects/'.length);
          const project = this.projects.get(projectId);
          if (project === undefined) {
            respond(404, { error: 'not_found' });
            return;
          }
          respond(200, project);
          return;
        }
        if (url.pathname === '/api/runs' && method === 'POST') {
          const clientRequestId = String(body?.clientRequestId ?? '');
          let runId = this.runsByClientRequestId.get(clientRequestId);
          if (runId === undefined) {
            this.runCounter += 1;
            runId = `run-${this.name}-${this.runCounter}`;
            this.runsByClientRequestId.set(clientRequestId, runId);
          }
          respond(202, { runId, clientRequestId, reused: runId !== undefined });
          return;
        }
        if (url.pathname === '/api/chat/stream') {
          response.statusCode = 200;
          response.setHeader('content-type', 'text/event-stream');
          response.setHeader('cache-control', 'no-cache');
          response.write(`event: token\ndata: hello-${this.name}\n\n`);
          response.write(`event: done\ndata: end\n\n`);
          response.end();
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

describe('Aurora tenant gateway', () => {
  let pool: Pool;
  let container: StartedPostgreSqlContainer;
  let tenantA: FakeOpenDesignTenant;
  let tenantB: FakeOpenDesignTenant;
  let tenantAServer: Server;
  let tenantBServer: Server;
  let tenantAOrigin: string;
  let tenantBOrigin: string;
  let appServer: Server;
  let appOrigin: string;
  let principalA: AuroraPrincipal;
  let principalB: AuroraPrincipal;
  let principalUnrouted: AuroraPrincipal;
  let cookieA: string;
  let cookieB: string;
  let cookieUnrouted: string;

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

    tenantA = new FakeOpenDesignTenant('tenant-a', ['deepseek-harness', 'claude']);
    tenantB = new FakeOpenDesignTenant('tenant-b', ['gemini', 'grok']);
    tenantAServer = await tenantA.start();
    tenantBServer = await tenantB.start();
    tenantAOrigin = `http://127.0.0.1:${(tenantAServer.address() as AddressInfo).port}`;
    tenantBOrigin = `http://127.0.0.1:${(tenantBServer.address() as AddressInfo).port}`;
    tenantA.projects.set('proj-a-1', { id: 'proj-a-1', name: 'Tenant A project', tenant: 'a' });
    tenantB.projects.set('proj-b-1', { id: 'proj-b-1', name: 'Tenant B project', tenant: 'b' });

    const appPort = await reservePort();
    appOrigin = `http://127.0.0.1:${appPort}`;
    const config: AuroraConfig = {
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

    const store = createAuroraSessionStore(pool, { ttlSeconds: config.sessionTtlSeconds });
    const nullTokens = {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    };
    const provision = async (
      subject: string,
    ): Promise<[AuroraPrincipal, string]> => {
      const principal = await upsertAuroraAccount(pool, {
        issuer: 'https://aurora-oidc.invalid',
        subject,
        email: `${subject}@example.com`,
        displayName: subject,
      });
      const cookie = await store.create(principal, nullTokens);
      return [principal, cookie];
    };
    [principalA, cookieA] = await provision('gateway-user-a');
    [principalB, cookieB] = await provision('gateway-user-b');
    [principalUnrouted, cookieUnrouted] = await provision('gateway-user-unrouted');

    // Operator seeds the authoritative tenant→upstream mapping; the browser
    // never does. Tenant C intentionally has no route.
    await pool.query('INSERT INTO tenant_routes (tenant_id, upstream_origin) VALUES ($1, $2)', [
      principalA.tenantId,
      tenantAOrigin,
    ]);
    await pool.query('INSERT INTO tenant_routes (tenant_id, upstream_origin) VALUES ($1, $2)', [
      principalB.tenantId,
      tenantBOrigin,
    ]);

    await withAuroraTransaction(pool, (client) =>
      applyAuroraTopup(client, principalA.accountId, '10.00'),
    );
    // Tenant B is topped up below the fixed run price so the insufficient
    // balance case resolves against a routed tenant.
    await withAuroraTransaction(pool, (client) =>
      applyAuroraTopup(client, principalB.accountId, '0.10'),
    );
  }, 120_000);

  afterAll(async () => {
    if (appServer) await closeServer(appServer);
    if (tenantAServer) await closeServer(tenantAServer);
    if (tenantBServer) await closeServer(tenantBServer);
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  function gatewayGet(
    path: string,
    options: { cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...(options.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${options.cookie}` }),
      ...options.headers,
    };
    return fetch(`${appOrigin}${path}`, { headers });
  }

  it('routes each authenticated tenant to its own upstream and serves multi-provider agents', async () => {
    const healthA = await gatewayGet('/api/health', { cookie: cookieA });
    expect(healthA.status).toBe(200);
    expect(await healthA.json()).toEqual({ ok: true, tenant: 'tenant-a' });

    const agentsA = await gatewayGet('/api/agents', { cookie: cookieA });
    expect(agentsA.status).toBe(200);
    // Multi-provider: tenant A's instance serves more than one agent and the
    // gateway does not restrict or rewrite the list.
    expect(await agentsA.json()).toEqual({ agents: ['deepseek-harness', 'claude'] });

    const healthB = await gatewayGet('/api/health', { cookie: cookieB });
    expect(await healthB.json()).toEqual({ ok: true, tenant: 'tenant-b' });
    const agentsB = await gatewayGet('/api/agents', { cookie: cookieB });
    expect(await agentsB.json()).toEqual({ agents: ['gemini', 'grok'] });
  });

  it('never leaks project data across tenants', async () => {
    const asA = await gatewayGet('/api/projects/proj-a-1', { cookie: cookieA });
    expect(asA.status).toBe(200);
    expect(await asA.json()).toMatchObject({ id: 'proj-a-1', tenant: 'a' });

    // Tenant B reaches only its own instance, which has no project proj-a-1.
    const asB = await gatewayGet('/api/projects/proj-a-1', { cookie: cookieB });
    expect(asB.status).toBe(404);
    expect(await asB.json()).toEqual({ error: 'not_found' });
  });

  it('ignores a browser-supplied upstream URL header', async () => {
    // The proxy target comes exclusively from the server-side session route;
    // a hostile header naming tenant B's origin must not redirect tenant A.
    const response = await gatewayGet('/api/projects/proj-a-1', {
      cookie: cookieA,
      headers: { 'x-aurora-upstream': tenantBOrigin },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'proj-a-1', tenant: 'a' });
  });

  it('rejects gateway traffic without an authenticated session', async () => {
    const response = await gatewayGet('/api/agents');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'aurora_unauthenticated', status: 401 });
  });

  it('rejects an authenticated tenant with no configured route', async () => {
    const response = await gatewayGet('/api/agents', { cookie: cookieUnrouted });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'aurora_tenant_route_missing',
      status: 404,
    });
  });

  it('never proxies control-plane /api/aurora paths', async () => {
    // The session route belongs to the control plane; an unrouted tenant can
    // still read its own session without being proxied or rejected.
    const response = await gatewayGet('/api/aurora/session', { cookie: cookieUnrouted });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      accountId: principalUnrouted.accountId,
    });
  });

  it('forwards streaming responses opaquely', async () => {
    const response = await gatewayGet('/api/chat/stream', { cookie: cookieA });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('data: hello-tenant-a');
    expect(body).toContain('event: done');
  });

  it('never forwards any browser cookie to a tenant upstream', async () => {
    // Even a non-Aurora cookie (analytics, app, or a sibling tenant's) must
    // not reach a tenant: tenants share the gateway origin, so such a value
    // would leak to whichever tenant the session routes to next.
    const response = await gatewayGet('/api/health', {
      cookie: cookieA,
      headers: { cookie: `${SESSION_COOKIE}=${cookieA}; analytics_id=leak-me; tenant_x=cookie` },
    });
    expect(response.status).toBe(200);
    const forwarded = tenantA.requests.find((request) => request.path === '/api/health');
    expect(forwarded?.cookieHeader).toBeUndefined();
  });

  it('never lets a tenant Set-Cookie land on the shared gateway origin', async () => {
    const response = await gatewayGet('/api/health', { cookie: cookieA });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('marks every proxied response uncacheable so no shared cache crosses tenants', async () => {
    const response = await gatewayGet('/api/health', { cookie: cookieA });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('never treats a case-variant of the /api/aurora namespace as proxied traffic', async () => {
    // Express routes case-insensitively, so /API/AURORA/* must stay owned by
    // the control plane and 404 here instead of reaching a tenant.
    const response = await gatewayGet('/API/AURORA/not-a-route');
    expect(response.status).toBe(404);
    expect(tenantA.requests.some((request) => request.path === '/API/AURORA/not-a-route')).toBe(
      false,
    );
  });

  describe('paid run admission at the gateway', () => {
    function createPaidRun(
      body: unknown,
      options: { cookie?: string } = {},
    ): Promise<Response> {
      return fetch(`${appOrigin}/api/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: appOrigin,
          ...(options.cookie === undefined
            ? {}
            : { cookie: `${SESSION_COOKIE}=${options.cookie}` }),
        },
        body: JSON.stringify(body),
      });
    }

    it('admits a paid run to the session tenant upstream instead of proxying it blindly', async () => {
      const before = tenantA.requests.filter(
        (request) => request.method === 'POST' && request.path === '/api/runs',
      ).length;
      const response = await createPaidRun(
        { clientRequestId: 'gw-run-1', message: 'Design a poster' },
        { cookie: cookieA },
      );
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { runId: string };
      expect(payload.runId).toMatch(/^run-tenant-a/u);

      // The run travelled through admission to tenant A's own upstream.
      const runRequests = tenantA.requests.filter(
        (request) => request.method === 'POST' && request.path === '/api/runs',
      );
      expect(runRequests.length).toBe(before + 1);
      expect(runRequests[0]!.body).toMatchObject({
        clientRequestId: 'gw-run-1',
        message: 'Design a poster',
      });
      // Tenant B's upstream never saw tenant A's run.
      expect(
        tenantB.requests.some(
          (request) => request.method === 'POST' && request.path === '/api/runs',
        ),
      ).toBe(false);
    });

    it('passes an explicit non-DSH agentId through unchanged (multi-provider)', async () => {
      const response = await createPaidRun(
        {
          clientRequestId: 'gw-run-claude',
          agentId: 'claude',
          message: 'Design a poster',
        },
        { cookie: cookieA },
      );
      expect(response.status).toBe(201);
      const runRequest = tenantA.requests.find(
        (request) => request.body?.clientRequestId === 'gw-run-claude',
      );
      expect(runRequest?.body).toMatchObject({ agentId: 'claude', message: 'Design a poster' });
    });

    it('rejects a cross-site paid run submission with 403', async () => {
      const before = tenantA.requests.length;
      const response = await fetch(`${appOrigin}/api/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example.com',
          cookie: `${SESSION_COOKIE}=${cookieA}`,
        },
        body: JSON.stringify({ clientRequestId: 'gw-run-csrf', message: 'cross-site' }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'cross_origin_forbidden' });
      expect(tenantA.requests.length).toBe(before);
    });

    it('does not bypass admission for a malformed run body', async () => {
      const before = tenantA.requests.length;
      const response = await createPaidRun({ message: 'missing clientRequestId' }, {
        cookie: cookieA,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'aurora_run_request_invalid',
        status: 409,
      });
      // A blind proxy would have forwarded this to the tenant; admission
      // rejected it before any upstream contact.
      expect(tenantA.requests.length).toBe(before);
    });

    it('maps an insufficient balance to the ledger 402 for a routed tenant', async () => {
      const response = await createPaidRun(
        { clientRequestId: 'gw-run-broke', message: 'broke' },
        { cookie: cookieB },
      );
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({
        code: 'aurora_insufficient_credits',
        status: 402,
      });
    });

    it('rejects a paid run for a tenant with no route before reserving', async () => {
      const response = await createPaidRun(
        { clientRequestId: 'gw-run-unrouted', message: 'no route' },
        { cookie: cookieUnrouted },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: 'aurora_tenant_route_missing',
        status: 404,
      });
    });
  });
});
