import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, RequestListener, Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuroraSessionSchema } from '@open-design/aurora-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createAuroraApp } from '../src/app.js';
import type { AuroraConfig } from '../src/config.js';

const SESSION_COOKIE = '__Host-aurora_session';
const LOGIN_COOKIE = '__Host-aurora_login';

interface AuthorizationRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

interface LoginStart {
  readonly authorizeUrl: URL;
  readonly loginCookie: string;
}

interface LoginResult {
  readonly callbackResponse: Response;
  readonly sessionCookie: string | undefined;
}

interface CompletedLogin {
  readonly callbackResponse: Response;
  readonly sessionCookie: string;
}

function b64url(input: Uint8Array | string): string {
  return Buffer.from(input).toString('base64url');
}

async function signEs256(privateKey: CryptoKey, header: object, payload: object): Promise<string> {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => (body += chunk));
  request.on('end', () => resolve(body));
  request.on('error', reject);
  return promise;
}

class FakeOidcProvider {
  nonceOverride: string | null = null;
  breakCodeVerifierCheck = false;
  readonly tokenRequests: URLSearchParams[] = [];
  readonly authorizations = new Map<string, AuthorizationRecord>();
  private readonly keys = crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);

  constructor(
    private issuerOrigin: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly subject: string,
    private readonly email: string,
    private readonly displayName: string,
  ) {}

  get origin(): string {
    return this.issuerOrigin;
  }

  setOrigin(origin: string): void {
    this.issuerOrigin = origin;
  }

  async start(): Promise<Server> {
    const { privateKey, publicKey } = await this.keys;

    const listener: RequestListener = async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', this.issuerOrigin);

        if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              issuer: this.issuerOrigin,
              authorization_endpoint: `${this.issuerOrigin}/authorize`,
              token_endpoint: `${this.issuerOrigin}/token`,
              jwks_uri: `${this.issuerOrigin}/jwks.json`,
              response_types_supported: ['code'],
              subject_types_supported: ['public'],
              id_token_signing_alg_values_supported: ['ES256'],
              code_challenge_methods_supported: ['S256'],
              token_endpoint_auth_methods_supported: ['client_secret_post'],
            }),
          );
          return;
        }

        if (request.method === 'GET' && url.pathname === '/jwks.json') {
          const jwk = await crypto.subtle.exportKey('jwk', publicKey);
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] }));
          return;
        }

        if (request.method === 'GET' && url.pathname === '/authorize') {
          const record: AuthorizationRecord = {
            clientId: url.searchParams.get('client_id') ?? '',
            redirectUri: url.searchParams.get('redirect_uri') ?? '',
            state: url.searchParams.get('state') ?? '',
            nonce: url.searchParams.get('nonce') ?? '',
            codeChallenge: url.searchParams.get('code_challenge') ?? '',
          };
          expect(record.clientId).toBe(this.clientId);
          expect(record.redirectUri).toMatch(/\/api\/aurora\/callback$/);
          expect(url.searchParams.get('response_type')).toBe('code');
          expect(url.searchParams.get('code_challenge_method')).toBe('S256');
          const code = `code-${randomBytes(6).toString('hex')}`;
          this.authorizations.set(code, record);
          const callback = new URL(record.redirectUri);
          callback.searchParams.set('code', code);
          callback.searchParams.set('state', record.state);
          response.statusCode = 302;
          response.setHeader('location', callback.toString());
          response.end();
          return;
        }

        if (request.method === 'POST' && url.pathname === '/token') {
          const body = new URLSearchParams(await readRequestBody(request));
          this.tokenRequests.push(body);
          if (body.get('client_id') !== this.clientId || body.get('client_secret') !== this.clientSecret) {
            response.statusCode = 401;
            response.end(JSON.stringify({ error: 'invalid_client' }));
            return;
          }
          const code = body.get('code') ?? '';
          const record = this.authorizations.get(code);
          if (record === undefined) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          const verifier = body.get('code_verifier') ?? '';
          const effectiveVerifier = this.breakCodeVerifierCheck ? 'tampered' : verifier;
          const expectedChallenge = b64url(createHash('sha256').update(effectiveVerifier).digest());
          if (verifier === '' || expectedChallenge !== record.codeChallenge) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'pkce mismatch' }));
            return;
          }
          const now = Math.floor(Date.now() / 1000);
          const accessToken = `at-${randomBytes(12).toString('hex')}`;
          const idToken = await signEs256(
            privateKey,
            { alg: 'ES256', typ: 'JWT', kid: 'test-key' },
            {
              iss: this.issuerOrigin,
              sub: this.subject,
              aud: this.clientId,
              nonce: this.nonceOverride ?? record.nonce,
              iat: now,
              exp: now + 300,
              email: this.email,
              name: this.displayName,
            },
          );
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: 3600,
              id_token: idToken,
              scope: 'openid profile email',
            }),
          );
          return;
        }

        response.statusCode = 404;
        response.end();
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

function cookieFrom(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((setCookie) => setCookie.startsWith(`${name}=`));
}

function cookieValue(setCookie: string | undefined): string {
  expect(setCookie).toBeDefined();
  return setCookie?.split(';')[0]?.split('=').slice(1).join('=') ?? '';
}

function cookieHeader(...pairs: ReadonlyArray<[name: string, value: string]>): string {
  return pairs.map(([name, value]) => `${name}=${value}`).join('; ');
}

async function listenApp(pool: Pool, config: AuroraConfig): Promise<Server> {
  const server = createAuroraApp({ db: pool, config }).listen(config.port, config.host);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return server;
}

function closeServer(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  return promise;
}

describe('Aurora OIDC sessions', () => {
  let pool: Pool;
  let container: StartedPostgreSqlContainer;
  let fake: FakeOidcProvider;
  let fakeServer: Server;
  let appServer: Server;
  let appOrigin: string;
  let baseConfig: AuroraConfig;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(120_000)
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const migration = await readFile(new URL('../src/migrations/001-auth.sql', import.meta.url), 'utf8');
    await pool.query(migration);

    fake = new FakeOidcProvider(
      'http://127.0.0.1:1',
      'aurora-web',
      'aurora-secret',
      'user-1',
      'user@example.com',
      'Example User',
    );
    fakeServer = await fake.start();
    fake.setOrigin(`http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`);

    const appPort = await reservePort();
    appOrigin = `http://127.0.0.1:${appPort}`;
    baseConfig = {
      host: '127.0.0.1',
      port: appPort,
      publicOrigin: appOrigin,
      oidc: {
        issuer: fake.origin,
        clientId: 'aurora-web',
        clientSecret: 'aurora-secret',
        allowInsecureHttp: true,
      },
      sessionTtlSeconds: 3600,
      loginStateTtlSeconds: 600,
      loginStateSigningSecret: 'test-signing-secret',
      stripe: { secretKey: 'sk_test_aurora', webhookSecret: 'whsec_test_aurora' },
    };
    appServer = await listenApp(pool, baseConfig);
  });

  afterAll(async () => {
    if (appServer) await closeServer(appServer);
    if (fakeServer) await closeServer(fakeServer);
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  async function beginLogin(): Promise<LoginStart> {
    const response = await fetch(`${appOrigin}/api/aurora/login`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    return {
      authorizeUrl: new URL(response.headers.get('location') ?? ''),
      loginCookie: cookieValue(cookieFrom(response, LOGIN_COOKIE)),
    };
  }

  async function completeLogin(login: LoginStart, tamperState = false): Promise<LoginResult> {
    const authorizeResponse = await fetch(login.authorizeUrl, { redirect: 'manual' });
    expect(authorizeResponse.status).toBe(302);
    const callbackUrl = new URL(authorizeResponse.headers.get('location') ?? '');
    if (tamperState) callbackUrl.searchParams.set('state', 'attacker-state');
    const callbackResponse = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: { cookie: cookieHeader([LOGIN_COOKIE, login.loginCookie]) },
    });
    return { callbackResponse, sessionCookie: cookieFrom(callbackResponse, SESSION_COOKIE) };
  }

  async function performLogin(): Promise<CompletedLogin> {
    const { callbackResponse, sessionCookie } = await completeLogin(await beginLogin());
    expect(callbackResponse.status).toBe(302);
    return { callbackResponse, sessionCookie: cookieValue(sessionCookie) };
  }

  it('redirects to the OIDC provider with PKCE, state, nonce, and a signed login cookie', async () => {
    const response = await fetch(`${appOrigin}/api/aurora/login`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    const authorizeUrl = new URL(response.headers.get('location') ?? '');
    expect(authorizeUrl.origin).toBe(baseConfig.oidc.issuer);
    expect(authorizeUrl.pathname).toBe('/authorize');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${appOrigin}/api/aurora/callback`);
    expect(authorizeUrl.searchParams.get('scope')).toBe('openid profile email');
    expect(authorizeUrl.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(authorizeUrl.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const loginCookie = cookieFrom(response, LOGIN_COOKIE);
    expect(loginCookie).toContain('Secure');
    expect(loginCookie).toContain('HttpOnly');
    expect(loginCookie).toContain('SameSite=Lax');
    expect(loginCookie).toContain('Path=/');
    expect(loginCookie).toContain('Max-Age=600');
  });

  it('completes the callback without ever exposing OIDC tokens to the browser', async () => {
    const { sessionCookie, callbackResponse } = await performLogin();

    expect(callbackResponse.headers.get('location')).toBe('/');
    const setCookie = cookieFrom(callbackResponse, SESSION_COOKIE);
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');

    const body = await callbackResponse.text();
    expect(body).not.toContain('access_token');
    expect(body).not.toContain('id_token');
    expect(sessionCookie).not.toMatch(/^at-/);

    const stored = await pool.query<{ id_hash: string; tokens_json: { accessToken?: string } }>(
      'SELECT id_hash, tokens_json FROM auth_sessions ORDER BY created_at DESC LIMIT 1',
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.tokens_json.accessToken).toMatch(/^at-[0-9a-f]+$/);
    expect(stored.rows[0]?.id_hash).not.toBe(sessionCookie);
    const rawTokenLeak = await pool.query('SELECT 1 AS leak FROM auth_sessions WHERE id_hash = $1', [
      sessionCookie,
    ]);
    expect(rawTokenLeak.rowCount).toBe(0);
  });

  it('returns the contract session DTO for anonymous and authenticated callers', async () => {
    const anonymousResponse = await fetch(`${appOrigin}/api/aurora/session`);
    expect(anonymousResponse.status).toBe(200);
    expect(AuroraSessionSchema.parse(await anonymousResponse.json())).toEqual({
      authenticated: false,
      accountId: null,
    });

    const { sessionCookie } = await performLogin();
    const response = await fetch(`${appOrigin}/api/aurora/session`, {
      headers: { cookie: cookieHeader([SESSION_COOKIE, sessionCookie]) },
    });
    const parsed = AuroraSessionSchema.parse(await response.json());
    expect(parsed.authenticated).toBe(true);
    expect(parsed.accountId).toMatch(/^acct_/);
  });

  it('reuses the same account when the same OIDC subject logs in again', async () => {
    const first = await performLogin();
    const second = await performLogin();

    const readAccountId = async (cookie: string): Promise<string> => {
      const response = await fetch(`${appOrigin}/api/aurora/session`, {
        headers: { cookie: cookieHeader([SESSION_COOKIE, cookie]) },
      });
      const parsed = AuroraSessionSchema.parse(await response.json());
      expect(parsed.authenticated).toBe(true);
      return parsed.accountId ?? '';
    };

    const firstId = await readAccountId(first.sessionCookie);
    expect(await readAccountId(second.sessionCookie)).toBe(firstId);

    const accounts = await pool.query('SELECT id FROM accounts');
    expect(accounts.rowCount).toBe(1);
  });

  it('rejects a callback whose state does not match the signed login cookie', async () => {
    const { callbackResponse, sessionCookie } = await completeLogin(await beginLogin(), true);
    expect(callbackResponse.status).toBe(401);
    expect(sessionCookie).toBeUndefined();

    const authenticated = await fetch(`${appOrigin}/api/aurora/session`);
    expect(AuroraSessionSchema.parse(await authenticated.json()).authenticated).toBe(false);
  });

  it('rejects a forged login cookie', async () => {
    const login = await beginLogin();
    const authorizeResponse = await fetch(login.authorizeUrl, { redirect: 'manual' });
    const callbackUrl = new URL(authorizeResponse.headers.get('location') ?? '');
    const callbackResponse = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: { cookie: cookieHeader([LOGIN_COOKIE, `${login.loginCookie.slice(0, -4)}dead`]) },
    });
    expect(callbackResponse.status).toBe(401);
  });

  it('rejects an expired login state', async () => {
    // loginStateTtlSeconds of 0 makes the signed login state expire the moment it is issued,
    // so expiry is deterministic without sleeping against the wall clock.
    const shortPort = await reservePort();
    const expiredStateApp = await listenApp(pool, {
      ...baseConfig,
      port: shortPort,
      publicOrigin: `http://127.0.0.1:${shortPort}`,
      loginStateTtlSeconds: 0,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${shortPort}/api/aurora/login`, {
        redirect: 'manual',
      });
      const loginCookie = cookieValue(cookieFrom(response, LOGIN_COOKIE));
      const authorizeResponse = await fetch(response.headers.get('location') ?? '', { redirect: 'manual' });
      const callbackUrl = new URL(authorizeResponse.headers.get('location') ?? '');
      const callbackResponse = await fetch(callbackUrl, {
        redirect: 'manual',
        headers: { cookie: cookieHeader([LOGIN_COOKIE, loginCookie]) },
      });
      expect(callbackResponse.status).toBe(401);
    } finally {
      await closeServer(expiredStateApp);
    }
  });

  it('rejects an id token whose nonce does not match the login nonce', async () => {
    fake.nonceOverride = 'attacker-nonce';
    try {
      const { callbackResponse, sessionCookie } = await completeLogin(await beginLogin());
      expect(callbackResponse.status).toBe(401);
      expect(sessionCookie).toBeUndefined();
    } finally {
      fake.nonceOverride = null;
    }
  });

  it('rejects a callback whose PKCE code verifier does not satisfy the challenge', async () => {
    fake.breakCodeVerifierCheck = true;
    try {
      const { callbackResponse, sessionCookie } = await completeLogin(await beginLogin());
      expect(callbackResponse.status).toBe(401);
      expect(sessionCookie).toBeUndefined();
    } finally {
      fake.breakCodeVerifierCheck = false;
    }
  });

  it('logs out same-origin, deletes the server session, and expires the cookie', async () => {
    const { sessionCookie } = await performLogin();
    const before = await fetch(`${appOrigin}/api/aurora/session`, {
      headers: { cookie: cookieHeader([SESSION_COOKIE, sessionCookie]) },
    });
    expect(AuroraSessionSchema.parse(await before.json()).authenticated).toBe(true);

    const logout = await fetch(`${appOrigin}/api/aurora/logout`, {
      method: 'POST',
      headers: { origin: appOrigin, cookie: cookieHeader([SESSION_COOKIE, sessionCookie]) },
    });
    expect(logout.status).toBe(200);
    expect(cookieFrom(logout, SESSION_COOKIE)).toContain('Max-Age=0');

    const after = await fetch(`${appOrigin}/api/aurora/session`, {
      headers: { cookie: cookieHeader([SESSION_COOKIE, sessionCookie]) },
    });
    expect(AuroraSessionSchema.parse(await after.json()).authenticated).toBe(false);
  });

  it('rejects cross-origin mutations with 403 and keeps the session valid', async () => {
    const { sessionCookie } = await performLogin();
    const crossOriginLogout = await fetch(`${appOrigin}/api/aurora/logout`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', cookie: cookieHeader([SESSION_COOKIE, sessionCookie]) },
    });
    expect(crossOriginLogout.status).toBe(403);

    const after = await fetch(`${appOrigin}/api/aurora/session`, {
      headers: { cookie: cookieHeader([SESSION_COOKIE, sessionCookie]) },
    });
    expect(AuroraSessionSchema.parse(await after.json()).authenticated).toBe(true);
  });

  it('treats a hostile session cookie value as an anonymous caller', async () => {
    const response = await fetch(`${appOrigin}/api/aurora/session`, {
      headers: { cookie: `${SESSION_COOKIE}=%zz-broken` },
    });
    expect(response.status).toBe(200);
    expect(AuroraSessionSchema.parse(await response.json())).toEqual({
      authenticated: false,
      accountId: null,
    });
  });

  it('reports login as unavailable when the identity provider cannot be reached', async () => {
    const deadPort = await reservePort();
    const deadIssuerApp = await listenApp(pool, {
      ...baseConfig,
      port: deadPort,
      publicOrigin: `http://127.0.0.1:${deadPort}`,
      oidc: { ...baseConfig.oidc, issuer: `http://127.0.0.1:${await reservePort()}` },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${deadPort}/api/aurora/login`, {
        redirect: 'manual',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'aurora_oidc_unavailable' });
    } finally {
      await closeServer(deadIssuerApp);
    }
  });

  it('sweeps expired sessions when a logout runs', async () => {
    const { sessionCookie } = await performLogin();
    await pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 hour'");

    const logout = await fetch(`${appOrigin}/api/aurora/logout`, {
      method: 'POST',
      headers: { origin: appOrigin, cookie: cookieHeader([SESSION_COOKIE, sessionCookie]) },
    });
    expect(logout.status).toBe(200);

    const remaining = await pool.query('SELECT id_hash FROM auth_sessions');
    expect(remaining.rowCount).toBe(0);
  });
});
