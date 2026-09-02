import type { Request, Response } from 'express';
import { Router } from 'express';

import { requireSameOriginForMutations } from '../auth/origin-guard.js';
import { createAuroraSessionStore, type AuroraPrincipal } from '../auth/session-store.js';
import type { AuroraConfig } from '../config.js';
import { getAuroraWallet, listAuroraLedgerEntries } from '../commerce/ledger.js';
import type { AuroraDatabase } from '../db.js';
import { requireAuroraSession } from './session.js';

export interface WalletRouterDeps {
  readonly db: AuroraDatabase;
  readonly config: AuroraConfig;
}

function readPrincipal(response: Response): AuroraPrincipal {
  const principal = response.locals.auroraPrincipal;
  if (principal === undefined) {
    throw new Error('requireAuroraSession must run before wallet routes');
  }
  return principal as AuroraPrincipal;
}

/**
 * Read-only wallet and ledger surfaces. Responses carry contract DTOs only —
 * never database rows, Stripe references, or pricing computation.
 */
export function createWalletRouter(deps: WalletRouterDeps): Router {
  const store = createAuroraSessionStore(deps.db, { ttlSeconds: deps.config.sessionTtlSeconds });
  const router = Router();

  // Read-only today; mounting the guard router-wide means future mutation
  // endpoints (for example top-ups) inherit same-origin protection.
  router.use(requireSameOriginForMutations(deps.config.publicOrigin));

  router.get('/wallet', requireAuroraSession(store), async (_request: Request, response) => {
    response.json(await getAuroraWallet(deps.db, readPrincipal(response).accountId));
  });

  router.get('/ledger', requireAuroraSession(store), async (_request: Request, response) => {
    response.json(await listAuroraLedgerEntries(deps.db, readPrincipal(response).accountId));
  });

  return router;
}
