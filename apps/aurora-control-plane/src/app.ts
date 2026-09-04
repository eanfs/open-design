import express, { type Express } from 'express';

import { createCommerceRouter } from './routes/commerce.js';
import { createRunAdmission, createRunsRouter } from './routes/runs.js';
import { createSessionRouter } from './routes/session.js';
import { createWalletRouter } from './routes/wallet.js';
import { createOpenDesignProxy } from './proxy/open-design.js';
import { createTenantRouteStore } from './tenants/routes.js';
import type { AuroraConfig } from './config.js';
import type { AuroraDatabase } from './db.js';

export interface AuroraAppDeps {
  readonly db: AuroraDatabase;
  readonly config: AuroraConfig;
}

export function createAuroraApp(deps: AuroraAppDeps): Express {
  const app = express();
  const tenants = createTenantRouteStore(deps.db);

  app.get('/api/aurora/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.use('/api/aurora', createSessionRouter({ db: deps.db, config: deps.config }));
  app.use('/api/aurora', createCommerceRouter({ db: deps.db, config: deps.config }));
  app.use('/api/aurora', createWalletRouter({ db: deps.db, config: deps.config }));
  app.use('/api/aurora', createRunsRouter({ db: deps.db, config: deps.config, tenants }));
  // Paid runs are also admitted at the gateway's OpenDesign path so the
  // opaque proxy below can never bypass reservation and charging for
  // `POST /api/runs`.
  app.post('/api/runs', ...createRunAdmission({ db: deps.db, config: deps.config, tenants }));
  // Everything else is opaque forwarding to the session tenant's OpenDesign
  // instance, resolved exclusively from the server-side tenant route.
  app.use(createOpenDesignProxy({ db: deps.db, config: deps.config, tenants }));

  return app;
}
