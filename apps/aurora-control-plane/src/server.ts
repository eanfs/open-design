import type { Server } from 'node:http';

import { createAuroraApp, type AuroraAppDeps } from './app.js';
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  startRunReconciliationScheduler,
  type RunReconciliationScheduler,
} from './runs/reconciler.js';
import { createOpenDesignUpstream } from './runs/upstream.js';

/**
 * Start the Aurora control plane: the Express app plus, when paid-run
 * admission is configured, the reserved-charge reconciliation scheduler.
 * The scheduler polls the OpenDesign upstream on the configured interval
 * until the server closes — or the process exits, since its timer is
 * unref'd and never keeps the process alive by itself.
 */
export async function startAuroraServer(deps: AuroraAppDeps): Promise<Server> {
  const app = createAuroraApp(deps);

  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(deps.config.port, deps.config.host);
    let scheduler: RunReconciliationScheduler | null = null;

    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      const runs = deps.config.runs;
      if (runs !== undefined) {
        scheduler = startRunReconciliationScheduler({
          db: deps.db,
          upstream: createOpenDesignUpstream({ baseUrl: runs.upstreamBaseUrl }),
          intervalMs: runs.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
        });
        server.once('close', () => scheduler?.stop());
      }
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
  });
}

export { createAuroraApp } from './app.js';
export type { AuroraAppDeps } from './app.js';
export type { AuroraConfig } from './config.js';
export { withAuroraTransaction } from './db.js';
export type { AuroraDatabase } from './db.js';
