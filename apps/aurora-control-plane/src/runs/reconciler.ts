import { AuroraLedgerError, closeAuroraReservation } from '../commerce/ledger.js';
import { withAuroraTransaction, type AuroraDatabase } from '../db.js';
import { listReservedRunCharges, runChargeReservationKey } from './admission.js';
import type { OpenDesignUpstream, RunStatusFetchOutcome } from './upstream.js';

/**
 * Task 7 reconciliation: paid-run reservations are settled or released from
 * the OpenDesign run's own terminal status, never from token or media usage.
 * `succeeded` settles the fixed price; `failed`/`canceled` (or a run that
 * no longer exists upstream) releases it; every non-terminal or unreachable
 * run keeps its reservation for the next poll. Reservations without a run id
 * cannot be polled and are recovered by the client's identical replay
 * instead (Task 6), so the poll never sees them.
 */

export type AuroraRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export type ReconcileDecision = 'settle' | 'release' | 'retry';

/** Canonical statuses plus the spellings OpenDesign has used over time. */
const RUN_STATUS_BY_RAW: Record<string, AuroraRunStatus | undefined> = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
  starting: 'running',
  cancelled: 'canceled',
};

/** Map an upstream status spelling onto the canonical run status, or null. */
export function normalizeRunStatus(status: string): AuroraRunStatus | null {
  return RUN_STATUS_BY_RAW[status] ?? null;
}

/**
 * The three settlement decisions. Only the terminal statuses decide; the
 * money-safe default for anything non-terminal is to keep retrying, because
 * releasing early could hand back credits for a run that later succeeds.
 */
export function decisionForRunStatus(status: AuroraRunStatus): ReconcileDecision {
  if (status === 'succeeded') return 'settle';
  if (status === 'failed' || status === 'canceled') return 'release';
  return 'retry';
}

/** What one poll pass observed about one run. */
export type ReconcileOutcome =
  | { readonly kind: 'status'; readonly status: AuroraRunStatus }
  /** The run no longer exists upstream, so it can never reach a paid state. */
  | { readonly kind: 'not-found' }
  /** Network loss, 5xx, or an unreadable body: keep the reservation. */
  | { readonly kind: 'unavailable' };

/** Identity of the charge to reconcile; the row is re-read under lock. */
export interface ReconcileChargeRef {
  readonly accountId: string;
  readonly clientRequestId: string;
}

export type ReconcileResult = 'settled' | 'released' | 'retry' | 'unchanged';

const CLOSE_KIND_BY_DECISION: Record<'settle' | 'release', 'settlement' | 'release'> = {
  settle: 'settlement',
  release: 'release',
};

const TERMINAL_STATE_BY_DECISION: Record<'settle' | 'release', 'settled' | 'released'> = {
  settle: 'settled',
  release: 'released',
};

function reconcileOutcomeOf(fetched: RunStatusFetchOutcome): ReconcileOutcome {
  if (fetched.kind === 'status') {
    const status = normalizeRunStatus(fetched.rawStatus);
    // An unknown status is not a terminal fact about the run; retry it.
    return status === null ? { kind: 'unavailable' } : { kind: 'status', status };
  }
  return fetched;
}

function decisionForOutcome(outcome: ReconcileOutcome): ReconcileDecision {
  if (outcome.kind === 'status') return decisionForRunStatus(outcome.status);
  return outcome.kind === 'not-found' ? 'release' : 'retry';
}

/**
 * Apply a terminal decision to one charge: close the ledger reservation and
 * flip the charge state in a single transaction, so a crash can never leave
 * the ledger closed while the charge still reads `reserved` (double-close)
 * or vice versa (credits stuck reserved). The row is locked `FOR UPDATE`
 * first, so two concurrent passes serialize; a second pass then sees the
 * terminal state and reports `unchanged`.
 *
 * A ledger close that fails because the reservation is missing or already
 * closed means the row and the ledger drifted (for example a legacy crash
 * window). The ledger is immutable and already reflects the money truth, so
 * the recovery is to flip only the charge row to the terminal state.
 */
async function applyTerminalDecision(
  db: AuroraDatabase,
  charge: ReconcileChargeRef,
  decision: 'settle' | 'release',
): Promise<'settled' | 'released' | 'unchanged'> {
  const terminalState = TERMINAL_STATE_BY_DECISION[decision];
  try {
    return await withAuroraTransaction(db, async (client) => {
      const current = await client.query<{ state: string }>(
        `SELECT state FROM run_charges
         WHERE account_id = $1 AND client_request_id = $2
         FOR UPDATE`,
        [charge.accountId, charge.clientRequestId],
      );
      if (current.rows[0]?.state !== 'reserved') {
        return 'unchanged';
      }
      await closeAuroraReservation(
        client,
        runChargeReservationKey(charge.accountId, charge.clientRequestId),
        CLOSE_KIND_BY_DECISION[decision],
      );
      const updated = await client.query(
        `UPDATE run_charges SET state = $1, updated_at = now()
         WHERE account_id = $2 AND client_request_id = $3 AND state = 'reserved'`,
        [terminalState, charge.accountId, charge.clientRequestId],
      );
      return updated.rowCount === 1 ? terminalState : 'unchanged';
    });
  } catch (error) {
    if (
      error instanceof AuroraLedgerError &&
      (error.code === 'aurora_reservation_not_found' ||
        error.code === 'aurora_reservation_closed')
    ) {
      const updated = await db.query(
        `UPDATE run_charges SET state = $1, updated_at = now()
         WHERE account_id = $2 AND client_request_id = $3 AND state = 'reserved'`,
        [terminalState, charge.accountId, charge.clientRequestId],
      );
      return updated.rowCount === 1 ? terminalState : 'unchanged';
    }
    throw error;
  }
}

/**
 * Reconcile one charge against what the poll observed. `retry` is reported
 * (and the reservation kept) for non-terminal runs and unavailable upstream
 * reads; terminal observations settle or release atomically with the ledger.
 */
export async function reconcileRunCharge(
  db: AuroraDatabase,
  charge: ReconcileChargeRef,
  outcome: ReconcileOutcome,
): Promise<ReconcileResult> {
  const decision = decisionForOutcome(outcome);
  if (decision === 'retry') {
    return 'retry';
  }
  return applyTerminalDecision(db, charge, decision);
}

export interface ReconcileCycleResult {
  settled: number;
  released: number;
  /** Still reserved: non-terminal, not found yet, or upstream unavailable. */
  retried: number;
  /** Charges whose reconciliation threw; they stay reserved for next pass. */
  failed: number;
}

export interface ReconcileCycleDeps {
  readonly db: AuroraDatabase;
  readonly upstream: OpenDesignUpstream;
}

/**
 * One full poll pass: read every reserved charge that carries a run id, ask
 * the upstream for each run's status, and settle/release/retry accordingly.
 * A charge that throws is counted and logged but never aborts the pass, so
 * one bad row cannot starve the others.
 */
export async function reconcileReservedCharges(
  deps: ReconcileCycleDeps,
): Promise<ReconcileCycleResult> {
  const charges = await listReservedRunCharges(deps.db);
  const result: ReconcileCycleResult = { settled: 0, released: 0, retried: 0, failed: 0 };
  for (const charge of charges) {
    if (charge.runId === null) {
      continue;
    }
    try {
      const fetched = await deps.upstream.fetchRunStatus(charge.runId);
      const applied = await reconcileRunCharge(deps.db, charge, reconcileOutcomeOf(fetched));
      if (applied === 'settled') result.settled += 1;
      else if (applied === 'released') result.released += 1;
      // `unchanged` only happens when another pass won the race; leave it
      // in the retried tally rather than pretending it settled anything.
      else result.retried += 1;
    } catch (error) {
      result.failed += 1;
      console.error(
        `Aurora reconciliation failed for charge ${charge.accountId}/${charge.clientRequestId}:`,
        error,
      );
    }
  }
  return result;
}

/** Default poll cadence for reserved-charge reconciliation. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 15_000;

export interface RunReconciliationScheduler {
  /** Stop scheduling further passes; an in-flight pass finishes naturally. */
  readonly stop: () => void;
}

export interface ReconcileSchedulerDeps extends ReconcileCycleDeps {
  readonly intervalMs: number;
}

/**
 * Poll reserved run charges on a fixed interval until stopped. One pass runs
 * immediately so a freshly started control plane settles promptly, and
 * overlapping passes are skipped rather than queued. The interval handle is
 * unref'd so the scheduler alone never keeps the process alive: process exit
 * therefore stops scheduling, as does an explicit `stop()` on server close.
 */
export function startRunReconciliationScheduler(
  deps: ReconcileSchedulerDeps,
): RunReconciliationScheduler {
  let cycleInFlight = false;
  const runPass = async (): Promise<void> => {
    if (cycleInFlight) {
      return;
    }
    cycleInFlight = true;
    try {
      await reconcileReservedCharges({ db: deps.db, upstream: deps.upstream });
    } catch (error) {
      console.error('Aurora run reconciliation pass failed:', error);
    } finally {
      cycleInFlight = false;
    }
  };
  void runPass();
  const timer = setInterval(() => {
    void runPass();
  }, deps.intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
