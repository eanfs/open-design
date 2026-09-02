CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  oidc_issuer TEXT NOT NULL,
  oidc_subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_oidc_identity_key UNIQUE (oidc_issuer, oidc_subject)
);

-- Only the SHA-256 hash of the browser session token is persisted; the raw
-- token lives exclusively in the browser cookie. OIDC tokens never leave the
-- database (tokens_json) and are never returned to the browser.
CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  tokens_json JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_account_id_idx ON auth_sessions (account_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions (expires_at);
