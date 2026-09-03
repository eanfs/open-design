import { randomUUID } from 'node:crypto';

import {
  AuroraLedgerEntrySchema,
  AuroraWalletSchema,
  type AuroraLedgerEntryDto,
  type AuroraWalletDto,
} from '@open-design/aurora-contracts';
import type { PoolClient } from 'pg';

import { withAuroraTransaction, type AuroraDatabase } from '../db.js';

export type AuroraLedgerErrorCode =
  | 'aurora_insufficient_credits'
  | 'aurora_reservation_conflict'
  | 'aurora_reservation_not_found'
  | 'aurora_reservation_closed'
  | 'aurora_account_not_found';

/**
 * Typed ledger failure carrying the commerce error contract, so Task 6 run
 * admission can map a rejection straight onto `AuroraCommerceErrorDto`.
 */
export class AuroraLedgerError extends Error {
  readonly code: AuroraLedgerErrorCode;
  readonly status: 402 | 409;

  constructor(code: AuroraLedgerErrorCode, message: string, status: 402 | 409) {
    super(message);
    this.name = 'AuroraLedgerError';
    this.code = code;
    this.status = status;
  }
}

export interface LedgerService {
  /** Move `amount` from available into reserved under `reservationKey`. */
  reserveCredits(accountId: string, reservationKey: string, amount: string): Promise<void>;
  /** Consume a reservation's reserved credits after a successful run. */
  settleReservation(reservationKey: string): Promise<void>;
  /** Return a reservation's reserved credits to available after a failed run. */
  releaseReservation(reservationKey: string): Promise<void>;
}

type EntryKind = 'topup' | 'reservation' | 'settlement' | 'release';

/** Mirrors the ledger_direction_matches_kind CHECK in 003-ledger.sql. */
const DIRECTION_BY_KIND: Record<EntryKind, 'credit' | 'debit'> = {
  topup: 'credit',
  reservation: 'debit',
  settlement: 'debit',
  release: 'credit',
};

/**
 * Credit amounts follow the contract format and fit wallets' NUMERIC(12, 2)
 * storage: at most 10 integer digits (9,999,999,999.99). Amounts beyond the
 * storage bound must fail typed validation here, not as a raw Postgres
 * overflow deep inside a transaction.
 */
const CREDIT_AMOUNT_PATTERN = /^\d{1,10}(?:\.\d{1,2})?$/;

function toCents(amount: string): bigint {
  const match = CREDIT_AMOUNT_PATTERN.exec(amount);
  if (match === null) {
    throw new Error(`Credit amounts must match ${CREDIT_AMOUNT_PATTERN.source}, received: ${amount}`);
  }
  const dot = amount.indexOf('.');
  if (dot === -1) {
    return BigInt(amount) * 100n;
  }
  return BigInt(amount.slice(0, dot)) * 100n + BigInt(amount.slice(dot + 1).padEnd(2, '0'));
}

function fromCents(cents: bigint): string {
  // BigInt division truncates toward zero, so whole/fraction must be computed
  // from the absolute value and the sign applied once; using the signed value
  // directly leaks '-' into the fraction ("-450n" -> "-4.-50").
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

function requirePositiveAmount(amount: string): bigint {
  const cents = toCents(amount);
  if (cents <= 0n) {
    throw new Error(`Credit amounts must be positive, received: ${amount}`);
  }
  return cents;
}

/** Normalize a database NUMERIC(12,2) string into the contract format. */
function toCreditAmount(value: string): string {
  return fromCents(toCents(value));
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23503';
}

async function ensureWalletRow(client: PoolClient, accountId: string): Promise<void> {
  try {
    await client.query(
      'INSERT INTO wallets (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING',
      [accountId],
    );
  } catch (error) {
    // The wallets FK is the only constraint here; a violation means the
    // account does not exist, which callers must see as a typed commerce
    // error rather than a raw Postgres failure.
    if (isForeignKeyViolation(error)) {
      throw new AuroraLedgerError(
        'aurora_account_not_found',
        `No Aurora account exists with id ${accountId}`,
        409,
      );
    }
    throw error;
  }
}

async function lockWalletBalances(
  client: PoolClient,
  accountId: string,
): Promise<{ available: bigint; reserved: bigint }> {
  const result = await client.query<{ available_credits: string; reserved_credits: string }>(
    'SELECT available_credits, reserved_credits FROM wallets WHERE account_id = $1 FOR UPDATE',
    [accountId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Wallet row for account ${accountId} disappeared inside its transaction`);
  }
  return { available: toCents(row.available_credits), reserved: toCents(row.reserved_credits) };
}

interface WalletDelta {
  readonly availableCents: bigint;
  readonly reservedCents: bigint;
}

async function applyWalletDelta(
  client: PoolClient,
  accountId: string,
  delta: WalletDelta,
): Promise<void> {
  const result = await client.query(
    `UPDATE wallets
     SET available_credits = available_credits + $2::numeric,
         reserved_credits = reserved_credits + $3::numeric,
         updated_at = now()
     WHERE account_id = $1`,
    [accountId, fromCents(delta.availableCents), fromCents(delta.reservedCents)],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Wallet row for account ${accountId} was missing during a balance update`);
  }
}

async function appendLedgerEntry(
  client: PoolClient,
  entry: {
    readonly accountId: string;
    readonly kind: EntryKind;
    readonly amountCents: bigint;
    readonly reservationKey: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_entries (id, account_id, kind, direction, amount, reservation_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      entry.accountId,
      entry.kind,
      DIRECTION_BY_KIND[entry.kind],
      fromCents(entry.amountCents),
      entry.reservationKey,
    ],
  );
}

async function closeReservation(
  db: AuroraDatabase,
  reservationKey: string,
  kind: 'settlement' | 'release',
): Promise<void> {
  await withAuroraTransaction(db, async (client) => {
    // Locking the reservation row serializes competing settle/release attempts.
    const reservation = await client.query<{ account_id: string; amount: string }>(
      `SELECT account_id, amount FROM ledger_entries
       WHERE reservation_key = $1 AND kind = 'reservation'
       FOR UPDATE`,
      [reservationKey],
    );
    const row = reservation.rows[0];
    if (row === undefined) {
      throw new AuroraLedgerError(
        'aurora_reservation_not_found',
        `No reservation exists for key ${reservationKey}`,
        409,
      );
    }
    const closed = await client.query(
      `SELECT 1 FROM ledger_entries
       WHERE reservation_key = $1 AND kind IN ('settlement', 'release')`,
      [reservationKey],
    );
    if ((closed.rowCount ?? 0) > 0) {
      throw new AuroraLedgerError(
        'aurora_reservation_closed',
        `Reservation ${reservationKey} is already settled or released`,
        409,
      );
    }
    const cents = toCents(row.amount);
    await appendLedgerEntry(client, {
      accountId: row.account_id,
      kind,
      amountCents: cents,
      reservationKey,
    });
    await applyWalletDelta(client, row.account_id, {
      availableCents: kind === 'release' ? cents : 0n,
      reservedCents: -cents,
    });
  });
}

/**
 * Grant a top-up inside a caller-owned transaction. Exported for the Stripe
 * webhook path, which must apply the event-id insert and the credit grant
 * atomically; balance transactions must never open their own transaction.
 */
export async function applyAuroraTopup(
  client: PoolClient,
  accountId: string,
  amount: string,
): Promise<void> {
  const cents = requirePositiveAmount(amount);
  await ensureWalletRow(client, accountId);
  await appendLedgerEntry(client, {
    accountId,
    kind: 'topup',
    amountCents: cents,
    reservationKey: null,
  });
  await applyWalletDelta(client, accountId, { availableCents: cents, reservedCents: 0n });
}

export function createAuroraLedgerService(db: AuroraDatabase): LedgerService {  return {
    reserveCredits: async (accountId, reservationKey, amount) => {
      const cents = requirePositiveAmount(amount);
      await withAuroraTransaction(db, async (client) => {
        await ensureWalletRow(client, accountId);
        const balances = await lockWalletBalances(client, accountId);
        if (balances.available < cents) {
          throw new AuroraLedgerError(
            'aurora_insufficient_credits',
            `Wallet for account ${accountId} cannot reserve ${amount} credits`,
            402,
          );
        }
        try {
          await appendLedgerEntry(client, {
            accountId,
            kind: 'reservation',
            amountCents: cents,
            reservationKey,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new AuroraLedgerError(
              'aurora_reservation_conflict',
              `Reservation key ${reservationKey} was already used`,
              409,
            );
          }
          throw error;
        }
        await applyWalletDelta(client, accountId, {
          availableCents: -cents,
          reservedCents: cents,
        });
      });
    },

    settleReservation: (reservationKey) => closeReservation(db, reservationKey, 'settlement'),

    releaseReservation: (reservationKey) => closeReservation(db, reservationKey, 'release'),
  };
}

/** Read-only wallet projection; a missing row is the zero wallet. */
export async function getAuroraWallet(
  db: AuroraDatabase,
  accountId: string,
): Promise<AuroraWalletDto> {
  const result = await db.query<{ available_credits: string; reserved_credits: string }>(
    'SELECT available_credits, reserved_credits FROM wallets WHERE account_id = $1',
    [accountId],
  );
  const row = result.rows[0];
  return AuroraWalletSchema.parse({
    availableCredits: toCreditAmount(row?.available_credits ?? '0'),
    reservedCredits: toCreditAmount(row?.reserved_credits ?? '0'),
  });
}

/**
 * Chronological ledger view for one account, shaped as contract DTOs only.
 * Unbounded by contract today: AuroraLedgerRequestSchema has no paging shape
 * (Task 2), and silently truncating a financial ledger would be worse than
 * an honest full read. Pagination must be a conscious contract change before
 * Task 6 UI drives real volume.
 */
export async function listAuroraLedgerEntries(
  db: AuroraDatabase,
  accountId: string,
): Promise<AuroraLedgerEntryDto[]> {
  const result = await db.query<{
    id: string;
    amount: string;
    direction: string;
    created_at: Date;
  }>(
    `SELECT id, amount, direction, created_at
     FROM ledger_entries
     WHERE account_id = $1
     ORDER BY seq`,
    [accountId],
  );
  const entries = result.rows.map((row) =>
    AuroraLedgerEntrySchema.parse({
      id: row.id,
      amount: toCreditAmount(row.amount),
      direction: row.direction,
      createdAt: row.created_at.toISOString(),
    }),
  );
  return entries;
}

/**
 * Recompute every wallet from a full ledger replay. Exported for tests and
 * offline audits only; balance transactions must never scan history.
 */
export async function rebuildWalletsFromLedger(db: AuroraDatabase): Promise<void> {
  await withAuroraTransaction(db, async (client) => {
    const grouped = await client.query<{ account_id: string; kind: string; total: string }>(
      'SELECT account_id, kind, SUM(amount) AS total FROM ledger_entries GROUP BY account_id, kind',
    );
    const wallets = new Map<string, { available: bigint; reserved: bigint }>();
    const walletFor = (accountId: string): { available: bigint; reserved: bigint } => {
      const existing = wallets.get(accountId);
      if (existing !== undefined) return existing;
      const created = { available: 0n, reserved: 0n };
      wallets.set(accountId, created);
      return created;
    };
    for (const row of grouped.rows) {
      const cents = toCents(row.total);
      const wallet = walletFor(row.account_id);
      switch (row.kind as EntryKind) {
        case 'topup':
          wallet.available += cents;
          break;
        case 'reservation':
          wallet.available -= cents;
          wallet.reserved += cents;
          break;
        case 'settlement':
          wallet.reserved -= cents;
          break;
        case 'release':
          wallet.reserved -= cents;
          wallet.available += cents;
          break;
        default:
          // A replay that meets an unknown kind must fail loudly; silently
          // skipping it would compute wrong balances with no error.
          throw new Error(`Ledger replay encountered unknown entry kind: ${row.kind}`);
      }
    }
    await client.query('DELETE FROM wallets');
    for (const [accountId, wallet] of wallets) {
      if (wallet.available < 0n || wallet.reserved < 0n) {
        throw new Error(
          `Ledger replay produced a negative balance for account ${accountId}; refusing to materialize it`,
        );
      }
      await client.query(
        'INSERT INTO wallets (account_id, available_credits, reserved_credits) VALUES ($1, $2, $3)',
        [accountId, fromCents(wallet.available), fromCents(wallet.reserved)],
      );
    }
  });
}
