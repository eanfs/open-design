import Stripe from 'stripe';

import type { AuroraConfig } from '../config.js';
import { withAuroraTransaction, type AuroraDatabase } from '../db.js';
import { applyAuroraTopup } from './ledger.js';

export function createAuroraStripeClient(config: AuroraConfig): Stripe {
  const stripeConfig = config.stripe;
  return new Stripe(stripeConfig.secretKey, {
    // Host overrides exist only for the local fake-Stripe test harness.
    ...(stripeConfig.apiProtocol === undefined ? {} : { protocol: stripeConfig.apiProtocol }),
    ...(stripeConfig.apiHost === undefined ? {} : { host: stripeConfig.apiHost }),
    ...(stripeConfig.apiPort === undefined ? {} : { port: stripeConfig.apiPort }),
  });
}

/**
 * Resolve the account's single Stripe customer, creating it on first use.
 * The mapping lives in the database so checkout and portal never depend on
 * browser-supplied customer identifiers. A concurrent first checkout may
 * create a second Stripe-side customer; the loser adopts the winner's row.
 */
export async function getOrCreateAuroraStripeCustomer(
  stripe: Stripe,
  db: AuroraDatabase,
  accountId: string,
): Promise<string> {
  const existing = await db.query<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM stripe_customers WHERE account_id = $1',
    [accountId],
  );
  const row = existing.rows[0];
  if (row !== undefined) return row.stripe_customer_id;

  const customer = await stripe.customers.create({ metadata: { accountId } });
  const inserted = await db.query(
    `INSERT INTO stripe_customers (account_id, stripe_customer_id)
     VALUES ($1, $2)
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId, customer.id],
  );
  if ((inserted.rowCount ?? 0) === 1) return customer.id;

  const raced = await db.query<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM stripe_customers WHERE account_id = $1',
    [accountId],
  );
  const racedRow = raced.rows[0];
  if (racedRow === undefined) {
    throw new Error(`Aurora Stripe customer mapping for account ${accountId} lost its race`);
  }
  return racedRow.stripe_customer_id;
}

export interface AuroraStripeEventOutcome {
  /** True when this exact event id was already applied by an earlier delivery. */
  readonly duplicate: boolean;
  /** True when the event wrote commerce state. */
  readonly applied: boolean;
}

/**
 * Apply a verified Stripe webhook event exactly once. The event id insert is
 * the first write of the transaction, so a redelivery hits the primary-key
 * conflict and returns without touching commerce state — duplicate grant
 * protection does not rely on the handler logic being pure.
 *
 * Credit grants honor the checkout-time catalog snapshot carried in the
 * session metadata (signed by Stripe) instead of re-reading the current
 * catalog, so a pricing change between checkout and completion cannot
 * rewrite an agreement that was already made.
 */
export async function handleAuroraStripeEvent(
  db: AuroraDatabase,
  event: Stripe.Event,
): Promise<AuroraStripeEventOutcome> {
  return withAuroraTransaction(db, async (client) => {
    const inserted = await client.query<{ stripe_event_id: string }>(
      `INSERT INTO stripe_events (stripe_event_id, type)
       VALUES ($1, $2)
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING stripe_event_id`,
      [event.id, event.type],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      return { duplicate: true, applied: false };
    }
    if (event.type !== 'checkout.session.completed') {
      return { duplicate: false, applied: false };
    }
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === 'unpaid') {
      return { duplicate: false, applied: false };
    }
    const accountId = session.metadata?.accountId;
    const credits = session.metadata?.credits;
    if (accountId === undefined || credits === undefined) {
      throw new Error(
        `Stripe checkout session ${String(session.id)} carries no Aurora metadata to apply`,
      );
    }
    await applyAuroraTopup(client, accountId, credits);
    return { duplicate: false, applied: true };
  });
}
