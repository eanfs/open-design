import { createHash, randomBytes } from 'node:crypto';

import type { AuroraDatabase } from '../db.js';
import { withAuroraTransaction } from '../db.js';

/** The authenticated caller as the commercial control plane sees it. */
export type AuroraPrincipal = {
  readonly accountId: string;
  readonly tenantId: string;
};

/** OIDC tokens persisted server-side; never serialized to the browser. */
export interface StoredOidcTokens {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAt: number | null;
}

export interface AuroraSessionStore {
  /** Persist a new session and return the opaque browser token for it. */
  create(principal: AuroraPrincipal, oidcTokens: StoredOidcTokens): Promise<string>;
  /** Resolve an unexpired session token to its principal, renewing bounded last-seen. */
  get(sessionToken: string): Promise<AuroraPrincipal | null>;
  /** Remove the session backing a token. */
  delete(sessionToken: string): Promise<void>;
}

export interface AuroraAccountIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

export interface AuroraSessionStoreOptions {
  readonly ttlSeconds: number;
  /** Renew last_seen_at at most once per window to avoid a write per request. */
  readonly lastSeenRefreshSeconds?: number;
}

const DEFAULT_LAST_SEEN_REFRESH_SECONDS = 300;

function hashSessionToken(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

export function createAuroraSessionStore(
  db: AuroraDatabase,
  options: AuroraSessionStoreOptions,
): AuroraSessionStore {
  const lastSeenRefreshSeconds =
    options.lastSeenRefreshSeconds ?? DEFAULT_LAST_SEEN_REFRESH_SECONDS;

  return {
    async create(principal, oidcTokens) {
      const sessionToken = randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO auth_sessions (id_hash, account_id, tokens_json, expires_at)
         VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4))`,
        [
          hashSessionToken(sessionToken),
          principal.accountId,
          JSON.stringify(oidcTokens),
          options.ttlSeconds,
        ],
      );
      return sessionToken;
    },

    async get(sessionToken) {
      const idHash = hashSessionToken(sessionToken);
      const result = await db.query<{ account_id: string; tenant_id: string }>(
        `SELECT a.id AS account_id, a.tenant_id AS tenant_id
         FROM auth_sessions s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.id_hash = $1 AND s.expires_at > now()`,
        [idHash],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      await db.query(
        `UPDATE auth_sessions SET last_seen_at = now()
         WHERE id_hash = $1 AND last_seen_at < now() - make_interval(secs => $2)`,
        [idHash, lastSeenRefreshSeconds],
      );
      return { accountId: row.account_id, tenantId: row.tenant_id };
    },

    async delete(sessionToken) {
      await db.query('DELETE FROM auth_sessions WHERE id_hash = $1', [
        hashSessionToken(sessionToken),
      ]);
      // Opportunistic sweep piggybacked on logouts so expired rows cannot
      // accumulate unboundedly between operator maintenance windows.
      await db.query('DELETE FROM auth_sessions WHERE expires_at < now()');
    },
  };
}

/**
 * Find or create the account (and its tenant) for an OIDC identity. The
 * `(oidc_issuer, oidc_subject)` pair is the stable external identity; profile
 * fields refresh on login without changing the account id.
 */
export async function upsertAuroraAccount(
  db: AuroraDatabase,
  identity: AuroraAccountIdentity,
): Promise<AuroraPrincipal> {
  return withAuroraTransaction(db, async (client) => {
    const existing = await client.query<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM accounts WHERE oidc_issuer = $1 AND oidc_subject = $2',
      [identity.issuer, identity.subject],
    );
    const existingRow = existing.rows[0];
    if (existingRow !== undefined) {
      await client.query(
        `UPDATE accounts SET email = $1, display_name = $2, updated_at = now()
         WHERE id = $3 AND (email IS DISTINCT FROM $1 OR display_name IS DISTINCT FROM $2)`,
        [identity.email, identity.displayName, existingRow.id],
      );
      return { accountId: existingRow.id, tenantId: existingRow.tenant_id };
    }

    const tenantId = `t_${randomBytes(9).toString('hex')}`;
    await client.query('INSERT INTO tenants (id) VALUES ($1)', [tenantId]);
    const accountId = `acct_${randomBytes(12).toString('hex')}`;
    const inserted = await client.query<{ id: string; tenant_id: string }>(
      `INSERT INTO accounts (id, tenant_id, oidc_issuer, oidc_subject, email, display_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (oidc_issuer, oidc_subject) DO NOTHING
       RETURNING id, tenant_id`,
      [
        accountId,
        tenantId,
        identity.issuer,
        identity.subject,
        identity.email,
        identity.displayName,
      ],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) {
      return { accountId: insertedRow.id, tenantId: insertedRow.tenant_id };
    }
    const raced = await client.query<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM accounts WHERE oidc_issuer = $1 AND oidc_subject = $2',
      [identity.issuer, identity.subject],
    );
    const racedRow = raced.rows[0];
    if (racedRow === undefined) {
      throw new Error('Aurora account upsert lost its race without producing a row');
    }
    return { accountId: racedRow.id, tenantId: racedRow.tenant_id };
  });
}
