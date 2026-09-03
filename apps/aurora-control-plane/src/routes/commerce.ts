import express, { type Request, Response } from 'express';
import { Router } from 'express';

import {
  AuroraCheckoutRequestSchema,
  AuroraCheckoutResponseSchema,
  AuroraTopUpRequestSchema,
  AuroraTopUpResponseSchema,
  AuroraPortalResponseSchema,
} from '@open-design/aurora-contracts';
import type Stripe from 'stripe';

import { requireSameOriginForMutations } from '../auth/origin-guard.js';
import { createAuroraSessionStore, type AuroraPrincipal } from '../auth/session-store.js';
import type { AuroraConfig } from '../config.js';
import {
  findAuroraSubscriptionPlan,
  findAuroraTopUpPlan,
  listAuroraPlanDtos,
} from '../commerce/catalog.js';
import {
  createAuroraStripeClient,
  getOrCreateAuroraStripeCustomer,
  handleAuroraStripeEvent,
} from '../commerce/stripe.js';
import type { AuroraDatabase } from '../db.js';
import { requireAuroraSession } from './session.js';

export interface CommerceRouterDeps {
  readonly db: AuroraDatabase;
  readonly config: AuroraConfig;
}

function readPrincipal(response: Response): AuroraPrincipal {
  const principal = response.locals.auroraPrincipal;
  if (principal === undefined) {
    throw new Error('requireAuroraSession must run before commerce routes');
  }
  return principal as AuroraPrincipal;
}

/**
 * Unknown plans, unknown billing intervals, and hostile payloads such as a
 * browser-supplied price id all collapse onto the same typed commerce error:
 * the browser never chooses pricing, so any such body names no sellable plan.
 */
function planNotFound(response: Response): void {
  response.status(409).json({
    code: 'aurora_plan_not_found',
    message: 'The requested plan does not exist in the Aurora catalog',
    status: 409,
  });
}

function checkoutUrl(url: string | null): string {
  if (url === null) {
    throw new Error('Stripe returned a checkout session without a hosted url');
  }
  return url;
}

export function createCommerceRouter(deps: CommerceRouterDeps): Router {
  const store = createAuroraSessionStore(deps.db, { ttlSeconds: deps.config.sessionTtlSeconds });
  const stripe = createAuroraStripeClient(deps.config);
  const router = Router();

  // Stripe's webhook deliveries carry no Origin header, so the router-wide
  // same-origin guard passes them while blocking cross-site browser posts.
  router.use(requireSameOriginForMutations(deps.config.publicOrigin));

  // The webhook must see the raw body for signature verification, so it is
  // registered before the router-wide JSON body parser.
  router.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (request: Request, response) => {
      const signature = request.headers['stripe-signature'];
      let event: Stripe.Event;
      try {
        if (typeof signature !== 'string') {
          throw new Error('missing stripe-signature header');
        }
        event = stripe.webhooks.constructEvent(
          request.body as Buffer,
          signature,
          deps.config.stripe.webhookSecret,
        );
      } catch {
        response.status(400).json({ error: 'invalid_stripe_signature' });
        return;
      }
      await handleAuroraStripeEvent(deps.db, event);
      response.json({ received: true });
    },
  );

  router.use(express.json());

  router.get('/plans', (_request, response) => {
    response.json(listAuroraPlanDtos());
  });

  router.post('/checkout', requireAuroraSession(store), async (request: Request, response) => {
    const principal = readPrincipal(response);
    const parsed = AuroraCheckoutRequestSchema.safeParse(request.body ?? {});
    const plan = parsed.success
      ? findAuroraSubscriptionPlan(parsed.data.planId, parsed.data.billingInterval)
      : null;
    if (plan === null) {
      planNotFound(response);
      return;
    }
    const customer = await getOrCreateAuroraStripeCustomer(stripe, deps.db, principal.accountId);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      customer,
      client_reference_id: principal.accountId,
      success_url: `${deps.config.publicOrigin}/?checkout=success`,
      cancel_url: `${deps.config.publicOrigin}/?checkout=cancelled`,
      metadata: {
        accountId: principal.accountId,
        planId: plan.id,
        billingInterval: plan.interval,
        pricingVersion: plan.pricingVersion,
        credits: plan.credits,
      },
    });
    response.json(AuroraCheckoutResponseSchema.parse({ url: checkoutUrl(session.url) }));
  });

  router.post('/top-up', requireAuroraSession(store), async (request: Request, response) => {
    const principal = readPrincipal(response);
    const parsed = AuroraTopUpRequestSchema.safeParse(request.body ?? {});
    const plan = parsed.success ? findAuroraTopUpPlan(parsed.data.planId) : null;
    if (plan === null) {
      planNotFound(response);
      return;
    }
    const customer = await getOrCreateAuroraStripeCustomer(stripe, deps.db, principal.accountId);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      customer,
      client_reference_id: principal.accountId,
      success_url: `${deps.config.publicOrigin}/?topup=success`,
      cancel_url: `${deps.config.publicOrigin}/?topup=cancelled`,
      metadata: {
        accountId: principal.accountId,
        planId: plan.id,
        pricingVersion: plan.pricingVersion,
        credits: plan.credits,
      },
    });
    response.json(AuroraTopUpResponseSchema.parse({ url: checkoutUrl(session.url) }));
  });

  router.post('/portal', requireAuroraSession(store), async (_request: Request, response) => {
    const principal = readPrincipal(response);
    const mapping = await deps.db.query<{ stripe_customer_id: string }>(
      'SELECT stripe_customer_id FROM stripe_customers WHERE account_id = $1',
      [principal.accountId],
    );
    const row = mapping.rows[0];
    if (row === undefined) {
      response.status(409).json({
        code: 'aurora_no_billing_profile',
        message: 'This account has no Stripe billing profile to manage yet',
        status: 409,
      });
      return;
    }
    const portal = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${deps.config.publicOrigin}/account`,
    });
    response.json(AuroraPortalResponseSchema.parse({ url: checkoutUrl(portal.url) }));
  });

  return router;
}
