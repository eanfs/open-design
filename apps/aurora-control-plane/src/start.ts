import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { loadAuroraConfigFromEnv } from './config/env.js';
import { applyAuroraMigrations } from './migrations.js';
import { startAuroraServer } from './server.js';

async function main(): Promise<void> {
  const { app: config, databaseUrl } = loadAuroraConfigFromEnv(process.env);
  const pool = new Pool({ connectionString: databaseUrl });

  // The compiled dist/ has no .sql (tsc does not copy them); the Docker image
  // copies migrations to AURORA_MIGRATIONS_DIR and points at it explicitly.
  const migrationsDir =
    process.env.AURORA_MIGRATIONS_DIR ??
    fileURLToPath(new URL('./migrations', import.meta.url));
  await applyAuroraMigrations(pool, migrationsDir);

  const server = await startAuroraServer({ db: pool, config });
  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  console.log(`Aurora control plane listening on ${config.host}:${config.port}`);
}

main().catch((error) => {
  console.error('Aurora control plane failed to start:', error);
  process.exit(1);
});
