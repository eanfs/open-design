import type { PoolClient } from 'pg';

import {
  AuroraLedgerError,
  createAuroraLedgerService,
} from '../commerce/ledger.js';
import { withAuroraTransaction, type AuroraDatabase } from '../db.js';
import {
  AURORA_RUN_AGENT_ID,
  digestAuroraRunBody,
  type OpenDesignUpstream,
} from './upstream.js';

/**
 * The single versioned fixed price for every paid run. It exists only here,
 * in server scope: the browser never sends a price, and the web may display
 * this value but never compute or override it. Any future price change is a
 * new entry in this constant (new pricingVersion), never a per-request
 * calculation.
 */
export const AURORA_RUN_PRICING = {
  pricingVersion: '2026-09',
  amount: '0.50',
} as const;

export type RunChargeState = 'reserved' | 'settled' | 'released';

export interface RunCharge {
  accountId: string;
  clientRequestId: string;
  pricingVersion: string;
  amount: string;
  bodyDigest: string;
  runId: string | null;
  state: RunChargeState;
}

export interface AuroraRunAdmissionDeps {
  readonly db: AuroraDatabase;
  readonly upstream: OpenDesignUpstream;
}

export interface RunAdmissionResult {
  readonly status: number;
  readonly body: unknown;
}

interface RunChargeRow {
  readonly account_id: string;
  readonly client_request_id: string;
  readonly pricing_version: string;
  readonly amount: string;
  readonly body_digest: string;
  readonly state: RunChargeState;
  readonly run_id: string | null;
}

function toRunCharge(row: RunChargeRow): RunCharge {
  return {
    accountId: row.account_id,
    clientRequestId: row.client_request_id,
    pricingVersion: row.pricing_version,
    amount: row.amount,
    bodyDigest: row.body_digest,
    runId: row.run_id,
    state: row.state,
  };
}

/**
 * The ledger reservation is keyed by the run charge identity, so a charge and
 * its credit reservation can never drift apart across replays.
 */
export function runChargeReservationKey(accountId: string, clientRequestId: string): string {
  return `run-charge:${accountId}:${clientRequestId}`;
}

function admissionRejection(status: 402 | 409, code: string, message: string): RunAdmissionResult {
  return { status, body: { code, message, status } };
}

const UPSTREAM_UNAVAILABLE = { status: 502, body: { error: 'aurora_upstream_unavailable' } };

/**
 * Insert the unique RunCharge, or return the existing row when the
 * (account_id, client_request_id) pair already exists. The INSERT waits out
 * any conflicting transaction, so a concurrent duplicate either sees the
 * committed winner or wins itself.
 */
async function insertOrReturnRunCharge(
  client: PoolClient,
  charge: {
    readonly accountId: string;
    readonly clientRequestId: string;
    readonly pricingVersion: string;
    readonly amount: string;
    readonly bodyDigest: string;
  },
): Promise<RunCharge & { readonly created: boolean }> {
  const inserted = await client.query<RunChargeRow>(
    `INSERT INTO run_charges
       (account_id, client_request_id, pricing_version, amount, body_digest, state)
     VALUES ($1, $2, $3, $4, $5, 'reserved')
     ON CONFLICT (account_id, client_request_id) DO NOTHING
     RETURNING account_id, client_request_id, pricing_version, amount, body_digest, state, run_id`,
    [
      charge.accountId,
      charge.clientRequestId,
      charge.pricingVersion,
      charge.amount,
      charge.bodyDigest,
    ],
  );
  const createdRow = inserted.rows[0];
  if (createdRow !== undefined) {
    return { ...toRunCharge(createdRow), created: true };
  }
  const existing = await client.query<RunChargeRow>(
    `SELECT account_id, client_request_id, pricing_version, amount, body_digest, state, run_id
     FROM run_charges WHERE account_id = $1 AND client_request_id = $2`,
    [charge.accountId, charge.clientRequestId],
  );
  const existingRow = existing.rows[0];
  if (existingRow === undefined) {
    throw new Error(
      `Run charge ${charge.clientRequestId} vanished between conflict and read`,
    );
  }
  return { ...toRunCharge(existingRow), created: false };
}

/**
 * Remove a charge row that never became a reservation (its credit reserve
 * failed). Deleting keeps the (account, clientRequestId) identity retryable
 * once the wallet can actually cover the fixed price.
 */
async function deleteUnlinkedRunCharge(
  db: AuroraDatabase,
  accountId: string,
  clientRequestId: string,
): Promise<void> {
  await db.query(
    `DELETE FROM run_charges
     WHERE account_id = $1 AND client_request_id = $2
       AND run_id IS NULL AND state = 'reserved'`,
    [accountId, clientRequestId],
  );
}

async function ledgerReservationExists(
  db: AuroraDatabase,
  reservationKey: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM ledger_entries
     WHERE reservation_key = $1 AND kind = 'reservation'`,
    [reservationKey],
  );
  return (result.rowCount ?? 0) > 0;
}

async function reserveOrReject(
  db: AuroraDatabase,
  accountId: string,
  clientRequestId: string,
  reservationKey: string,
  amount: string,
): Promise<RunAdmissionResult | null> {
  try {
    await createAuroraLedgerService(db).reserveCredits(
      accountId,
      reservationKey,
      amount,
    );
    return null;
  } catch (error) {
    await deleteUnlinkedRunCharge(db, accountId, clientRequestId);
    if (error instanceof AuroraLedgerError) {
      return admissionRejection(error.status, error.code, error.message);
    }
    throw error;
  }
}
/**
 * Admit one paid run: authenticate is already done by the route, so this
 * validates the body, resolves the fixed price server-side, claims the unique
 * RunCharge inside a transaction, reserves its credits, forwards the body
 * unchanged except the forced DSH agentId, and persists the returned run id.
 *
 * Idempotency: a repeated clientRequestId with the same outgoing body digest
 * replays the existing run id (or retries the unresolved upstream creation);
 * a different digest is a 409 conflict. A lost upstream response keeps the
 * reservation reserved so the identical retry can recover the same run.
 */
export async function admitPaidRun(
  deps: AuroraRunAdmissionDeps,
  accountId: string,
  requestBody: unknown,
): Promise<RunAdmissionResult> {
  if (typeof requestBody !== 'object' || requestBody === null || Array.isArray(requestBody)) {
    return admissionRejection(
      409,
      'aurora_run_request_invalid',
      'A paid run requires a JSON object body',
    );
  }
  const record = requestBody as Record<string, unknown>;
  const clientRequestId = record.clientRequestId;
  if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) {
    return admissionRejection(
      409,
      'aurora_run_request_invalid',
      'A non-empty clientRequestId is required before any credits are reserved',
    );
  }
  if (record.agentId !== undefined && record.agentId !== AURORA_RUN_AGENT_ID) {
    return admissionRejection(
      409,
      'aurora_agent_not_supported',
      `Paid runs only admit the ${AURORA_RUN_AGENT_ID} runtime`,
    );
  }

  // Everything except agentId travels byte-for-byte as serialized here, and
  // identical input bodies always produce identical outgoing bytes.
  const outgoingBody = JSON.stringify({ ...record, agentId: AURORA_RUN_AGENT_ID });
  const bodyDigest = digestAuroraRunBody(outgoingBody);

  const charge = await withAuroraTransaction(deps.db, (client) =>
    insertOrReturnRunCharge(client, {
      accountId,
      clientRequestId,
      pricingVersion: AURORA_RUN_PRICING.pricingVersion,
      amount: AURORA_RUN_PRICING.amount,
      bodyDigest,
    }),
  );

  if (charge.bodyDigest !== bodyDigest) {
    return admissionRejection(
      409,
      'aurora_run_request_conflict',
      `clientRequestId ${clientRequestId} is already bound to a different run body`,
    );
  }
  if (charge.runId !== null) {
    return { status: 201, body: { runId: charge.runId } };
  }

  const reservationKey = runChargeReservationKey(accountId, clientRequestId);
  // A fresh charge reserves here; a replayed charge normally already carries
  // its reservation. The exception is the crash window between the RunCharge
  // commit and the ledger reservation, which would otherwise let an identical
  // retry reach upstream without ever charging the wallet.
  const reservationMissing =
    charge.created ||
    (charge.runId === null && !(await ledgerReservationExists(deps.db, reservationKey)));
  if (reservationMissing) {
    const rejection = await reserveOrReject(
      deps.db,
      accountId,
      clientRequestId,
      reservationKey,
      AURORA_RUN_PRICING.amount,
    );
    if (rejection !== null) {
      return rejection;
    }
  }

  const outcome = await deps.upstream.createOrReuseRun(outgoingBody);
  if (outcome.kind === 'lost') {
    return UPSTREAM_UNAVAILABLE;
  }
  let upstreamBody: unknown;
  try {
    upstreamBody = JSON.parse(outcome.bodyText);
  } catch {
    return UPSTREAM_UNAVAILABLE;
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    // Structured upstream failure: forward it unchanged; the reservation
    // stays reserved for the reconciliation pass to settle or release.
    return { status: outcome.status, body: upstreamBody };
  }
  const runId = (upstreamBody as Record<string, unknown> | null)?.runId;
  if (typeof runId !== 'string' || runId.length === 0) {
    // A 2xx without a run id leaves the creation outcome undetermined.
    return UPSTREAM_UNAVAILABLE;
  }
  await deps.db.query(
    `UPDATE run_charges SET run_id = $1, updated_at = now()
     WHERE account_id = $2 AND client_request_id = $3 AND run_id IS NULL`,
    [runId, accountId, clientRequestId],
  );
  return { status: 201, body: upstreamBody };
}
