import express, { type Request, type Response } from 'express';
import { Router } from 'express';

import { requireSameOriginForMutations } from '../auth/origin-guard.js';
import { createAuroraSessionStore, type AuroraPrincipal } from '../auth/session-store.js';
import type { AuroraConfig } from '../config.js';
import type { AuroraDatabase } from '../db.js';
import { admitPaidRun } from '../runs/admission.js';
import { createOpenDesignUpstream } from '../runs/upstream.js';
import { requireAuroraSession } from './session.js';

export interface RunsRouterDeps {
  readonly db: AuroraDatabase;
  readonly config: AuroraConfig;
}

function readPrincipal(response: Response): AuroraPrincipal {
  const principal = response.locals.auroraPrincipal;
  if (principal === undefined) {
    throw new Error('requireAuroraSession must run before run routes');
  }
  return principal as AuroraPrincipal;
}

/**
 * Paid-run admission: `POST /runs` authenticates the session, enforces
 * same-origin, and hands the body to the admission service, which reserves
 * the fixed price and forwards the run to the configured OpenDesign upstream.
 * Responses carry the upstream body verbatim (201 on success) or typed
 * commerce errors.
 */
export function createRunsRouter(deps: RunsRouterDeps): Router {
  const runs = deps.config.runs;
  if (runs === undefined) {
    throw new Error('Aurora run admission requires the runs.upstreamBaseUrl configuration');
  }
  const upstream = createOpenDesignUpstream({ baseUrl: runs.upstreamBaseUrl });
  const store = createAuroraSessionStore(deps.db, { ttlSeconds: deps.config.sessionTtlSeconds });
  const router = Router();

  // Router-wide invariant shared with the other Aurora routers: every
  // state-changing request must be same-origin, so a paid run cannot be
  // submitted cross-site.
  router.use(requireSameOriginForMutations(deps.config.publicOrigin));
  router.use(express.json());

  router.post('/runs', requireAuroraSession(store), async (request: Request, response) => {
    const principal = readPrincipal(response);
    const result = await admitPaidRun(
      { db: deps.db, upstream },
      principal.accountId,
      request.body,
    );
    // Commerce rejections (401/402/409) are schema-valid by construction in
    // the admission service; every other status carries the upstream's own
    // body verbatim, which may coincidentally share a status code (e.g. an
    // upstream 409) without being an Aurora commerce error. The body is
    // therefore never reinterpreted here.
    response.status(result.status).json(result.body);
  });

  return router;
}
