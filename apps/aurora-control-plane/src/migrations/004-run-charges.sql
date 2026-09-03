-- Aurora paid-run admission (Task 6).
--
-- run_charges is the per-account idempotency gate for paid runs: one row per
-- (account_id, client_request_id), inserted before credits are reserved. The
-- row carries the server-chosen fixed price for the current pricing version,
-- the digest of the outgoing upstream body, the reservation lifecycle state,
-- and the nullable OpenDesign run id once the upstream creation is observed.
--
-- Like the ledger, run charges reference accounts without ON DELETE CASCADE:
-- an account with charge history must fail deletion loudly instead of
-- silently dropping billing facts.

CREATE TABLE run_charges (
  account_id TEXT NOT NULL REFERENCES accounts (id),
  client_request_id TEXT NOT NULL,
  pricing_version TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  body_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled', 'released')),
  run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT run_charges_account_request_key UNIQUE (account_id, client_request_id)
);

CREATE INDEX run_charges_run_id_idx ON run_charges (run_id) WHERE run_id IS NOT NULL;
