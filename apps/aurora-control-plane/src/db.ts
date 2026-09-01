import type { Pool, PoolClient } from 'pg';

export type AuroraDatabase = Pool;

export async function withAuroraTransaction<T>(
  pool: AuroraDatabase,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    try {
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (primaryError) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [primaryError, rollbackError],
          'Aurora transaction failed and rollback also failed',
          { cause: primaryError },
        );
      }
      throw primaryError;
    }
  } finally {
    client.release();
  }
}
