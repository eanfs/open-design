-- Aurora credit ledger (Task 5).
--
-- ledger_entries is the append-only fact source for every credit movement;
-- wallets is a projection that is updated inside the same transaction as the
-- entry it reflects. Balances are exact decimal strings capped at two
-- fraction digits ("12.50"), matching the CreditAmount contract.
--
-- No ON DELETE CASCADE anywhere in the credit model: the immutability trigger
-- on ledger_entries rejects cascaded deletes too, and an account with credit
-- history must fail account deletion loudly instead of silently losing facts.

CREATE TABLE wallets (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id),
  available_credits NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (available_credits >= 0),
  reserved_credits NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- seq gives the ledger a dense total order for stable reads and replay; id is
-- the public DTO identity. direction is fully determined by kind.
CREATE TABLE ledger_entries (
  seq BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  kind TEXT NOT NULL CHECK (kind IN ('topup', 'reservation', 'settlement', 'release')),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reservation_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_direction_matches_kind CHECK (
    (kind = 'topup' AND direction = 'credit')
    OR (kind = 'reservation' AND direction = 'debit')
    OR (kind = 'settlement' AND direction = 'debit')
    OR (kind = 'release' AND direction = 'credit')
  ),
  CONSTRAINT ledger_reservation_key_scope CHECK (
    (kind IN ('reservation', 'settlement', 'release')) = (reservation_key IS NOT NULL)
  )
);

CREATE INDEX ledger_entries_account_seq_idx ON ledger_entries (account_id, seq);

-- At most one lifecycle entry per reservation key per kind: duplicate
-- reservations and double settlement or release are impossible even when two
-- transactions race on the same key.
CREATE UNIQUE INDEX ledger_entries_reservation_lifecycle_idx
  ON ledger_entries (reservation_key, kind)
  WHERE reservation_key IS NOT NULL;

CREATE FUNCTION ledger_entries_reject_rewrite() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are immutable: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update_or_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_reject_rewrite();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_reject_rewrite();
