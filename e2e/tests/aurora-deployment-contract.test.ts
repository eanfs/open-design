import { createHash } from 'node:crypto';
import type { IncomingMessage, RequestListener, Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import {
  applyAuroraMigrations,
  createAuroraApp,
  type AuroraConfig,
} from '@open-design/aurora-control-plane';

// Task 8 deployment contract (issue #13, DSH-only: each tenant instance only
// installs/configures the deepseek-harness runtime).
//
// This is an integration contract test, not a user-facing e2e flow: it
// composes the real Aurora control plane (via its public package boundary)
// with a real PostgreSQL and two isolated OpenDesign tenant stand-ins, then
// verifies the dual-tenant routing/isolation contract through real HTTP:
//   - each authenticated tenant is routed to its own upstream,
//   - agents are served DSH-only and never leak across tenants,
//   - project data never crosses tenants,
//   - a browser-supplied upstream URL is ignored.
//
// Sessions and tenant routes are seeded directly in PostgreSQL to mirror the
// operator's provisioning path (real OIDC login is Task 3's seam, exercised
// by the control-plane session tests); the gateway behavior under test —
// authenticated tenant routing and isolation — is independent of how the
// session was created.

const SESSION_COOKIE = '__Host-aurora_session';

interface FakeTenantOptions {
  readonly name: string;
  readonly agentIds: readonly string[];
}

class FakeOpenDesignTenant {
  readonly projects = new Map<string, Record<string, unknown>>();

  constructor(readonly options: FakeTenantOptions) {}

  async start(): Promise<{ server: Server; origin: string }> {
    const listener: RequestListener = async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://tenant.fake');
      const respond = (status: number, payload: unknown): void => {
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      };
      if (url.pathname === '/api/health') {
        respond(200, { ok: true, tenant: this.options.name });
        return;
      }
      if (url.pathname === '/api/agents') {
        respond(200, { agents: [...this.options.agentIds] });
        return;
      }
      if (url.pathname.startsWith('/api/projects/')) {
        const project = this.projects.get(url.pathname.slice('/api/projects/'.length));
        if (project === undefined) {
          respond(404, { error: 'not_found' });
          return;
        }
        respond(200, project);
        return;
      }
      respond(404, { error: 'not_found' });
    };
    const server = createHttpServer(listener);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { server, origin: `http://127.0.0.1:${port}` };
  }
}

async function provisionTenant(pool: Pool, options: { subject: string; tenant: FakeOpenDesignTenant; upstreamOrigin: string }): Promise<string> {
  const tenantId = `t_${options.subject}`;
  const accountId = `acct_${options.subject}`;
  const sessionToken = `session-${options.subject}`;
  const idHash = createHash('sha256').update(sessionToken).digest('hex');

  await pool.query('INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [tenantId]);
  await pool.query(
    `INSERT INTO accounts (id, tenant_id, oidc_issuer, oidc_subject, email, display_name)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (oidc_issuer, oidc_subject) DO NOTHING`,
    [accountId, tenantId, 'https://aurora-oidc.invalid', options.subject, `${options.subject}@example.com`, options.subject],
  );
  await pool.query(
    `INSERT INTO tenant_routes (tenant_id, upstream_origin) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, options.upstreamOrigin],
  );
  await pool.query(
    `INSERT INTO auth_sessions (id_hash, account_id, tokens_json, expires_at)
     VALUES ($1, $2, $3::jsonb, now() + interval '1 hour')`,
    [idHash, accountId, JSON.stringify({ accessToken: null, refreshToken: null, idToken: null, expiresAt: null })],
  );
  return sessionToken;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('Aurora dual-tenant deployment contract', () => {
  let pool: Pool;
  let container: StartedPostgreSqlContainer;
  let tenantA: FakeOpenDesignTenant;
  let tenantB: FakeOpenDesignTenant;
  let tenantAServer: Server;
  let tenantBServer: Server;
  let tenantBOrigin: string;
  let appServer: Server;
  let appOrigin: string;
  let cookieA: string;
  let cookieB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(120_000)
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await applyAuroraMigrations(pool);

    tenantA = new FakeOpenDesignTenant({ name: 'tenant-a', agentIds: ['deepseek-harness'] });
    tenantB = new FakeOpenDesignTenant({ name: 'tenant-b', agentIds: ['deepseek-harness'] });
    const startedA = await tenantA.start();
    const startedB = await tenantB.start();
    tenantAServer = startedA.server;
    tenantBServer = startedB.server;
    tenantBOrigin = startedB.origin;
    tenantA.projects.set('proj-a-1', { id: 'proj-a-1', name: 'Tenant A project', tenant: 'a' });
    tenantB.projects.set('proj-b-1', { id: 'proj-b-1', name: 'Tenant B project', tenant: 'b' });

    cookieA = await provisionTenant(pool, {
      subject: 'tenant-a-user',
      tenant: tenantA,
      upstreamOrigin: startedA.origin,
    });
    cookieB = await provisionTenant(pool, {
      subject: 'tenant-b-user',
      tenant: tenantB,
      upstreamOrigin: startedB.origin,
    });

    const config: AuroraConfig = {
      host: '127.0.0.1',
      port: 0,
      publicOrigin: 'http://127.0.0.1:0',
      oidc: { issuer: 'https://aurora-oidc.invalid', clientId: 'aurora-web', clientSecret: 'aurora-secret' },
      sessionTtlSeconds: 3600,
      loginStateTtlSeconds: 600,
      loginStateSigningSecret: 'test-signing-secret',
      stripe: { secretKey: 'sk_test_aurora', webhookSecret: 'whsec_test_aurora' },
    };
    appServer = createAuroraApp({ db: pool, config }).listen(config.port, config.host);
    await new Promise<void>((resolve) => appServer.once('listening', resolve));
    appOrigin = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    if (appServer) await closeServer(appServer);
    if (tenantAServer) await closeServer(tenantAServer);
    if (tenantBServer) await closeServer(tenantBServer);
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  function gateway(path: string, cookie: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${appOrigin}${path}`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, ...headers },
    });
  }

  it('routes each authenticated tenant to its own upstream and serves the DSH-only runtime', async () => {
    const healthA = await gateway('/api/health', cookieA);
    expect(healthA.status).toBe(200);
    expect(await healthA.json()).toEqual({ ok: true, tenant: 'tenant-a' });

    const agentsA = await gateway('/api/agents', cookieA);
    expect(agentsA.status).toBe(200);
    // DSH-only (issue #13): each tenant instance only installs/configures the
    // deepseek-harness runtime, and the gateway passes the list through.
    expect(await agentsA.json()).toEqual({ agents: ['deepseek-harness'] });

    const agentsB = await gateway('/api/agents', cookieB);
    expect(await agentsB.json()).toEqual({ agents: ['deepseek-harness'] });
  });

  it('never leaks project data across tenants', async () => {
    const asA = await gateway('/api/projects/proj-a-1', cookieA);
    expect(asA.status).toBe(200);
    expect(await asA.json()).toMatchObject({ id: 'proj-a-1', tenant: 'a' });

    const asB = await gateway('/api/projects/proj-a-1', cookieB);
    expect(asB.status).toBe(404);
    expect(await asB.json()).toEqual({ error: 'not_found' });
  });

  it('ignores a browser-supplied upstream URL header', async () => {
    // The upstream comes exclusively from the server-side tenant route; a
    // header naming tenant B's origin must not redirect tenant A.
    const response = await gateway('/api/projects/proj-a-1', cookieA, {
      'x-aurora-upstream': tenantBOrigin,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'proj-a-1', tenant: 'a' });
  });

  it('rejects gateway traffic without an authenticated session', async () => {
    const response = await fetch(`${appOrigin}/api/agents`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'aurora_unauthenticated', status: 401 });
  });
});
