import type { Request, RequestHandler } from 'express';
import { Router } from 'express';

import { AuroraSessionSchema } from '@open-design/aurora-contracts';

import { requireSameOriginForMutations } from '../auth/origin-guard.js';
import {
  AURORA_LOGIN_COOKIE_NAME,
  AURORA_SESSION_COOKIE_NAME,
  AuroraLoginError,
  beginAuroraLogin,
  completeAuroraLogin,
} from '../auth/oidc.js';
import {
  createAuroraSessionStore,
  upsertAuroraAccount,
  type AuroraPrincipal,
  type AuroraSessionStore,
} from '../auth/session-store.js';
import type { AuroraConfig } from '../config.js';
import type { AuroraDatabase } from '../db.js';

export interface SessionRouterDeps {
  readonly db: AuroraDatabase;
  readonly config: AuroraConfig;
}

/** Cookie attributes required for the `__Host-` prefix and session safety. */
const SESSION_COOKIE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';

function readCookie(headerValue: string | undefined, name: string): string | undefined {
  if (headerValue === undefined) return undefined;
  for (const part of headerValue.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const raw = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      // A hostile cookie value that is not valid percent-encoding is treated
      // as absent rather than crashing the request with a URIError.
      return undefined;
    }
  }
  return undefined;
}

function serializeCookie(name: string, value: string | null, maxAgeSeconds: number): string {
  const cookieValue = value === null ? '' : value;
  return `${name}=${encodeURIComponent(cookieValue)}; Max-Age=${maxAgeSeconds}; ${SESSION_COOKIE_ATTRIBUTES}`;
}

function clearCookie(name: string): string {
  return serializeCookie(name, null, 0);
}

function oidcRejection(error: unknown): { code: string; message: string } {
  if (error instanceof AuroraLoginError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'aurora_oidc_rejected',
    message: 'The OIDC login could not be verified',
  };
}

async function resolvePrincipal(
  store: AuroraSessionStore,
  request: Request,
): Promise<AuroraPrincipal | null> {
  const token = readCookie(request.headers.cookie, AURORA_SESSION_COOKIE_NAME);
  return token === undefined ? null : await store.get(token);
}

/** Resolve the session cookie into a principal or reject with a 401 commerce error. */
export function requireAuroraSession(store: AuroraSessionStore): RequestHandler {
  return async (request: Request, response, next) => {
    const principal = await resolvePrincipal(store, request);
    if (principal === null) {
      response.status(401).json({
        code: 'aurora_unauthenticated',
        message: 'An authenticated Aurora session is required',
        status: 401,
      });
      return;
    }
    response.locals.auroraPrincipal = principal;
    next();
  };
}

export function createSessionRouter(deps: SessionRouterDeps): Router {
  const store = createAuroraSessionStore(deps.db, { ttlSeconds: deps.config.sessionTtlSeconds });
  const router = Router();

  router.use(requireSameOriginForMutations(deps.config.publicOrigin));

  router.get('/session', async (request, response) => {
    const principal = await resolvePrincipal(store, request);
    response.json(
      AuroraSessionSchema.parse({
        authenticated: principal !== null,
        accountId: principal?.accountId ?? null,
      }),
    );
  });

  router.get('/login', async (_request, response) => {
    try {
      const login = await beginAuroraLogin(deps.config);
      response.append(
        'Set-Cookie',
        serializeCookie(
          AURORA_LOGIN_COOKIE_NAME,
          login.loginCookieValue,
          login.loginCookieMaxAgeSeconds,
        ),
      );
      response.redirect(302, login.redirectUrl.toString());
    } catch {
      response.status(503).json({
        code: 'aurora_oidc_unavailable',
        message: 'The identity provider is currently unavailable',
        status: 503,
      });
    }
  });

  router.get('/callback', async (request, response) => {
    let identity;
    try {
      const loginCookie = readCookie(request.headers.cookie, AURORA_LOGIN_COOKIE_NAME);
      const callbackUrl = new URL(`${deps.config.publicOrigin}${request.originalUrl}`);
      identity = await completeAuroraLogin(deps.config, callbackUrl, loginCookie);
    } catch (error) {
      const rejection = oidcRejection(error);
      response.status(401).json({ ...rejection, status: 401 });
      return;
    }
    try {
      const principal = await upsertAuroraAccount(deps.db, identity);
      const sessionToken = await store.create(principal, identity);
      response.append(
        'Set-Cookie',
        serializeCookie(AURORA_SESSION_COOKIE_NAME, sessionToken, deps.config.sessionTtlSeconds),
      );
      response.append('Set-Cookie', clearCookie(AURORA_LOGIN_COOKIE_NAME));
      response.redirect(302, '/');
    } catch (error) {
      // Persistence failures are server-side faults, not rejected logins;
      // they must surface loudly instead of masquerading as a 401.
      console.error('Aurora session persistence failed:', error);
      response.status(500).json({
        code: 'aurora_session_persist_failed',
        message: 'The session could not be persisted',
        status: 500,
      });
    }
  });

  router.post('/logout', async (request, response) => {
    const token = readCookie(request.headers.cookie, AURORA_SESSION_COOKIE_NAME);
    if (token !== undefined) {
      await store.delete(token);
    }
    response.append('Set-Cookie', clearCookie(AURORA_SESSION_COOKIE_NAME));
    response.json({ ok: true });
  });

  return router;
}
