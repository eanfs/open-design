import express, { type Request, type RequestHandler, type Response } from 'express';
import { Router } from 'express';

import { requireSameOriginForMutations } from '../auth/origin-guard.js';
import { createAuroraSessionStore, type AuroraPrincipal } from '../auth/session-store.js';
import type { AuroraConfig } from '../config.js';
import type { AuroraDatabase } from '../db.js';
import { admitPaidRun } from '../runs/admission.js';
import { createOpenDesignUpstream } from '../runs/upstream.js';
import type { TenantRouteStore } from '../tenants/routes.js';
import { requireAuroraSession } from './session.js';

export interface RunsRouterDeps {
  readonly db: AuroraDatabase;
  readonly config: AuroraConfig;
  readonly tenants: TenantRouteStore;
}

const TENANT_NOT_ROUTED = {
  status: 404,
  body: {
    code: 'aurora_tenant_route_missing',
    message: 'The authenticated tenant has no configured OpenDesign upstream',
    status: 404,
  },
};

function readPrincipal(response: Response): AuroraPrincipal {
  const principal = response.locals.auroraPrincipal;
  if (principal === undefined) {
    throw new Error('requireAuroraSession must run before run routes');
  }
  return principal as AuroraPrincipal;
}

/**
 * Paid-run admission chain shared by the control-plane `/api/aurora/runs`
 * surface and the gateway `POST /api/runs` interception, so the opaque proxy
 * can never forward a paid run without reserving and charging first. The
 * upstream is resolved per request from the session tenant's route: the
 * browser never selects the OpenDesign target.
 */
export function createRunAdmission(deps: RunsRouterDeps): RequestHandler[] {
  const store = createAuroraSessionStore(deps.db, { ttlSeconds: deps.config.sessionTtlSeconds });
  const admit: RequestHandler = async (request, response, next) => {
    try {
      const principal = readPrincipal(response);
      const route = await deps.tenants.getByTenantId(principal.tenantId);
      if (route === null) {
        response.status(TENANT_NOT_ROUTED.status).json(TENANT_NOT_ROUTED.body);
        return;
      }
      const upstream = createOpenDesignUpstream({ baseUrl: route.upstreamOrigin.toString() });
      const result = await admitPaidRun(
        { db: deps.db, upstream },
        principal.accountId,
        request.body,
      );
      response.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  };

  return [
    requireSameOriginForMutations(deps.config.publicOrigin),
    express.json(),
    requireAuroraSession(store),
    admit,
  ];
}

export function createRunsRouter(deps: RunsRouterDeps): Router {
  const router = Router();
  router.post('/runs', ...createRunAdmission(deps));
  return router;
}
