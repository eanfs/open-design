import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import { withAuroraTransaction } from './db.js';

/** The control plane's own SQL migrations, applied by this package only. */
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Apply pending SQL migrations in filename order, recording each applied file
 * in `schema_migrations`. Each migration runs on one dedicated connection
 * inside a real transaction (via `withAuroraTransaction`), so a crash between
 * applying a migration and recording it rolls back both — a restart never
 * re-runs a migration that was already applied.
 */
export async function applyAuroraMigrations(
  pool: Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if ((applied.rowCount ?? 0) > 0) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await withAuroraTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
  }
}
