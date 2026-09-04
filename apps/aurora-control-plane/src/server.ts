import type { Server } from 'node:http';

import { createAuroraApp, type AuroraAppDeps } from './app.js';

export async function startAuroraServer(deps: AuroraAppDeps): Promise<Server> {
  const app = createAuroraApp(deps);

  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(deps.config.port, deps.config.host);

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
export { applyAuroraMigrations } from './migrations.js';
