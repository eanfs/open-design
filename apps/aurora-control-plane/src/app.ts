import express, { type Express } from 'express';

import type { AuroraConfig } from './config.js';
import type { AuroraDatabase } from './db.js';

export interface AuroraAppDeps {
  readonly db: AuroraDatabase;
  readonly config: AuroraConfig;
}

export function createAuroraApp(_deps: AuroraAppDeps): Express {
  const app = express();

  app.get('/api/aurora/health', (_request, response) => {
    response.json({ ok: true });
  });

  return app;
}
