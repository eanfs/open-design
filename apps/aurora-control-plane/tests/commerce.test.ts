import { readFile } from 'node:fs/promises';
import type { IncomingMessage, RequestListener, Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  AuroraCheckoutResponseSchema,
  AuroraPlansResponseSchema,
  AuroraPortalResponseSchema,
  AuroraTopUpResponseSchema,
} from '@open-design/aurora-contracts';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createAuroraApp } from '../src/app.js';
import {
  createAuroraSessionStore,
  upsertAuroraAccount,
  type AuroraPrincipal,
} from '../src/auth/session-store.js';
import type { AuroraConfig } from '../src/config.js';

const SESSION_COOKIE = '__Host-aurora_session';
const WEBHOOK_SECRET = 'whsec_test_aurora';

// The catalog is server-owned configuration; these literals pin the versioned
// pricing the routes must serve and forward to Stripe. Browser input never
// carries any of these values.
const PRICING_VERSION = '2026-09';
const SUBSCRIPTION_PRICES: Readonly<Record<string, string>> = {
  'creator:month': 'price_creator_month_usd',
  'creator:year': 'price_creator_year_usd',
  'pro:month': 'price_pro_month_usd',
  'pro:year': 'price_pro_year_usd',
  'studio:month': 'price_studio_month_usd',
  'studio:year': 'price_studio_year_usd',
};
const TOP_UP_PRICES: Readonly<Record<string, { price: string; credits: string }>> = {
  creator: { price: 'price_creator_topup_usd', credits: '50.00' },
  pro: { price: 'price_pro_topup_usd', credits: '150.00' },
  studio: { price: 'price_studio_topup_usd', credits: '500.00' },
};

function readRequestBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => (body += chunk));
  request.on('end', () => resolve(body));
  request.on('error', reject);
  return promise;
}

interface CapturedStripeRequest {
  readonly path: string;
  readonly body: URLSearchParams;
}

/** Minimal Stripe API stand-in; captures form bodies so tests can assert that
 * the server — not the browser — chose every price. */
class FakeStripeApi {
  readonly requests: CapturedStripeRequest[] = [];
  private counter = 0;

  async start(): Promise<Server> {
    const listener: RequestListener = async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://stripe.fake');
        const body = new URLSearchParams(await readRequestBody(request));
        this.requests.push({ path: url.pathname, body });
        const respond = (payload: object): void => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(payload));
        };
        this.counter += 1;
        const id = String(this.counter);
        if (url.pathname === '/v1/checkout/sessions') {
          respond({
            id: `cs_test_${id}`,
            object: 'checkout.session',
            url: `https://billing.stripe.fake/checkout/${id}`,
            mode: body.get('mode') ?? 'payment',
          });
          return;
        }
        if (url.pathname === '/v1/billing_portal/sessions') {
          respond({
            id: `bps_test_${id}`,
            object: 'billing_portal.session',
            url: `https://billing.stripe.fake/portal/${id}`,
          });
          return;
        }
        if (url.pathname === '/v1/customers') {
          respond({ id: `cus_test_${id}`, object: 'customer' });
          return;
        }
        respond({});
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    };
    const server = createHttpServer(listener);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  }

  requestsTo(path: string): CapturedStripeRequest[] {
    return this.requests.filter((request) => request.path === path);
  }
}

async function reservePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function closeServer(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  return promise;
}

describe('Aurora Stripe commerce', () => {
  let pool: Pool;
  let container: StartedPostgreSqlContainer;
  let fakeStripe: FakeStripeApi;
  let fakeStripeServer: Server;
  let appServer: Server;
  let appOrigin: string;
  let config: AuroraConfig;
  let account: AuroraPrincipal;
  let sessionCookie: string;
  let sessionStore: ReturnType<typeof createAuroraSessionStore>;
  let webhookSigner: Stripe;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withStartupTimeout(120_000)
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    for (const file of ['001-auth.sql', '002-commerce.sql', '003-ledger.sql']) {
      const migration = await readFile(new URL(`../src/migrations/${file}`, import.meta.url), 'utf8');
      await pool.query(migration);
    }

    fakeStripe = new FakeStripeApi();
    fakeStripeServer = await fakeStripe.start();
    const stripePort = (fakeStripeServer.address() as AddressInfo).port;

    const appPort = await reservePort();
    appOrigin = `http://127.0.0.1:${appPort}`;
    config = {
      host: '127.0.0.1',
      port: appPort,
      publicOrigin: appOrigin,
      oidc: {
        issuer: 'https://aurora-oidc.invalid',
        clientId: 'aurora-web',
        clientSecret: 'aurora-secret',
      },
      sessionTtlSeconds: 3600,
      loginStateTtlSeconds: 600,
      loginStateSigningSecret: 'test-signing-secret',
      stripe: {
        secretKey: 'sk_test_aurora',
        webhookSecret: WEBHOOK_SECRET,
        apiProtocol: 'http',
        apiHost: '127.0.0.1',
        apiPort: stripePort,
      },
    };
    appServer = createAuroraApp({ db: pool, config }).listen(config.port, config.host);
    await new Promise<void>((resolve) => appServer.once('listening', resolve));

    account = await upsertAuroraAccount(pool, {
      issuer: 'https://aurora-oidc.invalid',
      subject: 'commerce-user-1',
      email: 'commerce-user-1@example.com',
      displayName: 'Commerce User 1',
    });
    const store = createAuroraSessionStore(pool, { ttlSeconds: config.sessionTtlSeconds });
    sessionStore = store;
    sessionCookie = await store.create(account, {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    });
    webhookSigner = new Stripe('sk_test_aurora');
  }, 120_000);

  afterAll(async () => {
    if (appServer) await closeServer(appServer);
    if (fakeStripeServer) await closeServer(fakeStripeServer);
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { cookie: `${SESSION_COOKIE}=${sessionCookie}`, ...extra };
  }

  async function postCheckout(options: {
    body: unknown;
    sessionCookie?: string;
    origin?: string;
  }): Promise<Response> {
    return fetch(`${appOrigin}/api/aurora/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: options.origin ?? appOrigin,
        ...(options.sessionCookie === undefined
          ? {}
          : { cookie: `${SESSION_COOKIE}=${options.sessionCookie}` }),
      },
      body: JSON.stringify(options.body),
    });
  }

  async function postTopUp(body: unknown): Promise<Response> {
    return fetch(`${appOrigin}/api/aurora/top-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: appOrigin, ...authHeaders() },
      body: JSON.stringify(body),
    });
  }

  async function postPortal(sessionCookieOverride?: string): Promise<Response> {
    return fetch(`${appOrigin}/api/aurora/portal`, {
      method: 'POST',
      headers: {
        origin: appOrigin,
        cookie: `${SESSION_COOKIE}=${sessionCookieOverride ?? sessionCookie}`,
      },
    });
  }

  async function readWallet(): Promise<{ availableCredits: string; reservedCredits: string }> {
    const result = await pool.query<{ available_credits: string; reserved_credits: string }>(
      'SELECT available_credits, reserved_credits FROM wallets WHERE account_id = $1',
      [account.accountId],
    );
    const row = result.rows[0];
    return {
      availableCredits: row?.available_credits ?? '0.00',
      reservedCredits: row?.reserved_credits ?? '0.00',
    };
  }

  async function countTopUps(): Promise<number> {
    const result = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ledger_entries WHERE account_id = $1 AND kind = 'topup'",
      [account.accountId],
    );
    return result.rows[0]?.n ?? 0;
  }

  function signedEventPayload(event: {
    id: string;
    type: string;
    object: Record<string, unknown>;
  }): { payload: string; signature: string } {
    const payload = JSON.stringify({
      id: event.id,
      object: 'event',
      type: event.type,
      data: { object: event.object },
    });
    const signature = webhookSigner.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    return { payload, signature };
  }

  async function deliverStripeEvent(event: {
    id: string;
    type: string;
    object: Record<string, unknown>;
  }): Promise<Response> {
    const { payload, signature } = await signedEventPayload(event);
    return fetch(`${appOrigin}/api/aurora/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
  }

  function checkoutCompletedObject(
    eventId: string,
    overrides?: Partial<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      id: `cs_test_${eventId}`,
      object: 'checkout.session',
      payment_status: 'paid',
      client_reference_id: account.accountId,
      metadata: {
        accountId: account.accountId,
        planId: 'creator',
        pricingVersion: PRICING_VERSION,
        credits: TOP_UP_PRICES.creator?.credits,
      },
      ...overrides,
    };
  }

  /** Deliver one signed checkout.session.completed event twice and report how
   * many credit grants actually landed in the ledger. */
  async function deliverStripeEventTwice(eventId: string): Promise<{
    firstStatus: number;
    status: number;
    appliedEvents: number;
  }> {
    const first = await deliverStripeEvent({
      id: eventId,
      type: 'checkout.session.completed',
      object: checkoutCompletedObject(eventId),
    });
    const second = await deliverStripeEvent({
      id: eventId,
      type: 'checkout.session.completed',
      object: checkoutCompletedObject(eventId),
    });
    return { firstStatus: first.status, status: second.status, appliedEvents: await countTopUps() };
  }

  it('serves the versioned server catalog as display-only plan DTOs', async () => {
    const response = await fetch(`${appOrigin}/api/aurora/plans`);
    expect(response.status).toBe(200);

    const rawBody = JSON.stringify(await response.json());
    expect(rawBody).not.toContain('price_');
    expect(rawBody).not.toContain('stripePriceId');

    const plans = AuroraPlansResponseSchema.parse(JSON.parse(rawBody));
    expect(plans).toHaveLength(9);
    const creatorMonth = plans.find(
      (plan) => plan.id === 'creator' && plan.billingInterval === 'month',
    );
    expect(creatorMonth).toMatchObject({
      id: 'creator',
      name: 'Creator Monthly',
      billingInterval: 'month',
      displayPrice: '$19',
      currency: 'usd',
      credits: '120.00',
    });
    const studioTopUp = plans.find(
      (plan) => plan.id === 'studio' && plan.billingInterval === 'top-up',
    );
    expect(studioTopUp).toMatchObject({
      id: 'studio',
      billingInterval: 'top-up',
      displayPrice: '$75',
      currency: 'usd',
      credits: '500.00',
    });
  });

  it('builds checkout sessions for every subscription plan from the server catalog', async () => {
    for (const planId of ['creator', 'pro', 'studio'] as const) {
      for (const billingInterval of ['month', 'year'] as const) {
        const response = await postCheckout({ body: { planId, billingInterval }, sessionCookie });
        expect(response.status).toBe(200);
        const { url } = AuroraCheckoutResponseSchema.parse(await response.json());
        expect(url).toMatch(/^https:\/\//);
      }
    }

    const sessions = fakeStripe.requestsTo('/v1/checkout/sessions');
    expect(sessions).toHaveLength(6);
    for (const request of sessions) {
      expect(request.body.get('mode')).toBe('subscription');
      expect(request.body.get('client_reference_id')).toBe(account.accountId);
      expect(request.body.get('metadata[accountId]')).toBe(account.accountId);
      expect(request.body.get('metadata[pricingVersion]')).toBe(PRICING_VERSION);
      expect((request.body.get('success_url') ?? '').startsWith(appOrigin)).toBe(true);
    }
    const byInterval = (billingInterval: string): CapturedStripeRequest =>
      sessions.find((request) => request.body.get('metadata[billingInterval]') === billingInterval)!;
    expect(byInterval('month').body.get('line_items[0][price]')).toBe(SUBSCRIPTION_PRICES['creator:month']);
  });

  it('rejects a browser that tries to submit its own Stripe price id', async () => {
    const requestsBefore = fakeStripe.requestsTo('/v1/checkout/sessions').length;
    const response = await postCheckout({
      body: { priceId: 'attacker-price' },
      sessionCookie,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'aurora_plan_not_found',
      status: 409,
    });
    expect(fakeStripe.requestsTo('/v1/checkout/sessions')).toHaveLength(requestsBefore);
  });

  it('rejects unknown plan ids with a typed commerce error', async () => {
    const response = await postCheckout({
      body: { planId: 'ghost', billingInterval: 'month' },
      sessionCookie,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'aurora_plan_not_found', status: 409 });
  });

  it('requires an authenticated session for checkout', async () => {
    const response = await postCheckout({
      body: { planId: 'creator', billingInterval: 'month' },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'aurora_unauthenticated', status: 401 });
  });

  it('rejects cross-origin checkout submissions', async () => {
    const response = await postCheckout({
      body: { planId: 'creator', billingInterval: 'month' },
      sessionCookie,
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
  });

  it('builds a payment-mode top-up session from the server catalog', async () => {
    const response = await postTopUp({ planId: 'creator' });
    expect(response.status).toBe(200);
    const { url } = AuroraTopUpResponseSchema.parse(await response.json());
    expect(url).toMatch(/^https:\/\//);

    const topUps = fakeStripe.requestsTo('/v1/checkout/sessions').slice(-1);
    expect(topUps).toHaveLength(1);
    const request = topUps[0]!;
    expect(request.body.get('mode')).toBe('payment');
    expect(request.body.get('line_items[0][price]')).toBe(TOP_UP_PRICES.creator?.price);
    expect(request.body.get('metadata[credits]')).toBe(TOP_UP_PRICES.creator?.credits);
    expect(request.body.get('client_reference_id')).toBe(account.accountId);
  });

  it('rejects top-ups for unknown plan ids', async () => {
    const response = await postTopUp({ planId: 'ghost' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'aurora_plan_not_found', status: 409 });
  });

  it('denies the billing portal until the account has a Stripe customer', async () => {
    // A fresh account keeps this independent of the checkouts earlier tests ran.
    const fresh = await upsertAuroraAccount(pool, {
      issuer: 'https://aurora-oidc.invalid',
      subject: 'commerce-user-portal',
      email: 'commerce-user-portal@example.com',
      displayName: 'Commerce User Portal',
    });
    const freshCookie = await sessionStore.create(fresh, {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
    });

    const denied = await postPortal(freshCookie);
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: 'aurora_no_billing_profile', status: 409 });

    const checkout = await postCheckout({
      body: { planId: 'creator', billingInterval: 'month' },
      sessionCookie: freshCookie,
    });
    expect(checkout.status).toBe(200);

    const allowed = await postPortal(freshCookie);
    expect(allowed.status).toBe(200);
    const { url } = AuroraPortalResponseSchema.parse(await allowed.json());
    expect(url).toMatch(/^https:\/\//);

    const portals = fakeStripe.requestsTo('/v1/billing_portal/sessions');
    expect(portals).toHaveLength(1);
    expect(portals[0]!.body.get('customer')).toMatch(/^cus_test_/);

    const mappings = await pool.query('SELECT account_id FROM stripe_customers WHERE account_id = $1', [
      fresh.accountId,
    ]);
    expect(mappings.rowCount).toBe(1);
  });

  it('rejects webhook deliveries with an invalid signature', async () => {
    const { payload } = await signedEventPayload({
      id: 'evt_bad_signature',
      type: 'checkout.session.completed',
      object: checkoutCompletedObject('evt_bad_signature'),
    });
    const response = await fetch(`${appOrigin}/api/aurora/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      body: payload,
    });
    expect(response.status).toBe(400);
    expect(await countTopUps()).toBe(0);
  });

  it('applies a webhook event exactly once across repeated deliveries', async () => {
    const result = await deliverStripeEventTwice('evt_same');
    expect(result.firstStatus).toBe(200);
    expect(result.status).toBe(200);
    expect(result).toMatchObject({ appliedEvents: 1 });

    expect(await readWallet()).toEqual({
      availableCredits: TOP_UP_PRICES.creator?.credits ?? '',
      reservedCredits: '0.00',
    });
    const events = await pool.query('SELECT type FROM stripe_events WHERE stripe_event_id = $1', [
      'evt_same',
    ]);
    expect(events.rowCount).toBe(1);
  });

  it('records unrelated event types without writing commerce state', async () => {
    const before = await countTopUps();
    const first = await deliverStripeEvent({
      id: 'evt_invoice_unrelated',
      type: 'invoice.paid',
      object: { id: 'in_test_1', object: 'invoice' },
    });
    const second = await deliverStripeEvent({
      id: 'evt_invoice_unrelated',
      type: 'invoice.paid',
      object: { id: 'in_test_1', object: 'invoice' },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await countTopUps()).toBe(before);

    const events = await pool.query(
      'SELECT stripe_event_id FROM stripe_events WHERE stripe_event_id = $1',
      ['evt_invoice_unrelated'],
    );
    expect(events.rowCount).toBe(1);
  });

  it('keeps per-account credits scoped to the metadata account', async () => {
    const other = await upsertAuroraAccount(pool, {
      issuer: 'https://aurora-oidc.invalid',
      subject: 'commerce-user-2',
      email: 'commerce-user-2@example.com',
      displayName: 'Commerce User 2',
    });
    await deliverStripeEvent({
      id: 'evt_other_account',
      type: 'checkout.session.completed',
      object: {
        ...checkoutCompletedObject('evt_other_account'),
        client_reference_id: other.accountId,
        metadata: {
          accountId: other.accountId,
          planId: 'pro',
          pricingVersion: PRICING_VERSION,
          credits: TOP_UP_PRICES.pro?.credits,
        },
      },
    });

    const otherWallet = await pool.query<{ available_credits: string }>(
      'SELECT available_credits FROM wallets WHERE account_id = $1',
      [other.accountId],
    );
    expect(otherWallet.rows[0]?.available_credits).toBe(TOP_UP_PRICES.pro?.credits);
    expect((await readWallet()).availableCredits).toBe(TOP_UP_PRICES.creator?.credits);
  });
});
