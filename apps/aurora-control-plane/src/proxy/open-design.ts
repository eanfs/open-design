import type { Request, RequestHandler, Response } from 'express';
// `http-proxy` is CommonJS; under Node ESM only the default import exposes
// the server factory (a named import type-checks but fails at runtime).
import httpProxy from 'http-proxy';

import { isSameOriginSubmission } from '../auth/origin-guard.js';
import { resolveAuroraSession } from '../auth/resolve-session.js';
import { createAuroraSessionStore } from '../auth/session-store.js';
import type { AuroraConfig } from '../config.js';
import type { AuroraDatabase } from '../db.js';
import type { TenantRouteStore } from '../tenants/routes.js';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OpenDesignProxyDeps {
  readonly db: AuroraDatabase;
  readonly config: AuroraConfig;
  readonly tenants: TenantRouteStore;
}

const UNAUTHENTICATED = {
  status: 401,
  body: {
    code: 'aurora_unauthenticated',
    message: 'An authenticated Aurora session is required',
    status: 401,
  },
};

const TENANT_NOT_ROUTED = {
  status: 404,
  body: {
    code: 'aurora_tenant_route_missing',
    message: 'The authenticated tenant has no configured OpenDesign upstream',
    status: 404,
  },
};

const UPSTREAM_UNAVAILABLE = { status: 502, body: { error: 'aurora_upstream_unavailable' } };

/**
 * Opaque gateway proxy from the control plane to the session tenant's
 * OpenDesign instance. It authenticates, resolves the upstream exclusively
 * from the server-side tenant route (a browser-supplied upstream URL is
 * ignored by construction), and streams the request and response through
 * unchanged, so OpenDesign API, SSE, artifact, frame, preview, and download
 * traffic needs no control-plane reimplementation.
 *
 * Paid runs never reach this proxy: the gateway admits `POST /api/runs` with
 * its own route before this catch-all is consulted, so the generic proxy can
 * never bypass reservation and charging.
 */
export function createOpenDesignProxy(deps: OpenDesignProxyDeps): RequestHandler {
  const store = createAuroraSessionStore(deps.db, { ttlSeconds: deps.config.sessionTtlSeconds });
  // changeOrigin rewrites Host to the tenant upstream. No `xfwd`: the gateway
  // forwards headers opaquely, so the tenant sees the X-Forwarded-For chain
  // exactly as it arrived instead of a masked peer address.
  const proxy = httpProxy.createProxyServer({ changeOrigin: true });

  // Never forward any browser Cookie to a tenant instance. The tenant shares
  // the gateway origin with every other tenant, so a browser cookie set by one
  // app or tenant would otherwise be observable by whichever tenant the session
  // is routed to next, breaking isolation. The gateway resolves the session
  // from the Cookie before this point; the upstream never needs it.
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.removeHeader('cookie');
  });

  // Tenant responses share the gateway origin with every other tenant, so a
  // tenant-issued Set-Cookie would land on the shared origin and fixate or
  // poison cookie state for the wrong tenant. The browser never needs a
  // tenant's own cookies: it talks to tenants only through this gateway.
  //
  // The same shared origin means no shared cache (browser, CDN, intermediary)
  // may serve one tenant's response to another tenant that requests the same
  // URL, so every proxied response is marked uncacheable.
  proxy.on('proxyRes', (proxyRes) => {
    delete proxyRes.headers['set-cookie'];
    proxyRes.headers['cache-control'] = 'private, no-store';
  });

  return async (request: Request, response: Response, next) => {
    try {
      // Control-plane routes own the `/api/aurora` namespace; anything under it
      // that a router did not match must 404 here instead of leaking to a
      // tenant's OpenDesign instance. Express routes case-insensitively, so the
      // guard must match case-insensitively too.
      if (request.path.toLowerCase().startsWith('/api/aurora')) {
        next();
        return;
      }
      // Defense in depth over the SameSite=Lax session cookie: mutations
      // through the gateway must be same-origin, matching the control-plane
      // routes.
      if (
        !SAFE_METHODS.has(request.method) &&
        !isSameOriginSubmission(deps.config.publicOrigin, request.headers.origin)
      ) {
        response.status(403).json({ error: 'cross_origin_forbidden' });
        return;
      }
      const principal = await resolveAuroraSession(store, request);
      if (principal === null) {
        response.status(UNAUTHENTICATED.status).json(UNAUTHENTICATED.body);
        return;
      }
      const route = await deps.tenants.getByTenantId(principal.tenantId);
      if (route === null) {
        response.status(TENANT_NOT_ROUTED.status).json(TENANT_NOT_ROUTED.body);
        return;
      }

      const fail = (): void => {
        if (!response.headersSent) {
          response.status(UPSTREAM_UNAVAILABLE.status).json(UPSTREAM_UNAVAILABLE.body);
        } else {
          response.destroy();
        }
      };
      try {
        proxy.web(request, response, { target: route.upstreamOrigin.toString() }, fail);
      } catch {
        fail();
      }
    } catch (error) {
      // Fail closed: any unexpected error in session resolution or tenant
      // routing must reach the Express error handler as a 500, never hang.
      next(error);
    }
  };
}
