-- Aurora Stripe commerce (Task 4).
--
-- stripe_customers maps each authenticated Aurora account to its single Stripe
-- customer so checkout and billing portal sessions are always constructed from
-- server state, never from browser input.
--
-- stripe_events is the webhook idempotency ledger: an event id is inserted
-- before any commerce state is written inside the same transaction, so a
-- redelivered Stripe event can never apply twice.

CREATE TABLE stripe_customers (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stripe_events (
  stripe_event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
