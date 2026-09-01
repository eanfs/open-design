import { describe, expect, it } from 'vitest';

import {
  AuroraCheckoutRequestSchema,
  AuroraCheckoutResponseSchema,
  AuroraCommerceErrorSchema,
  AuroraLedgerEntrySchema,
  AuroraLedgerRequestSchema,
  AuroraLedgerResponseSchema,
  AuroraPlanSchema,
  AuroraPlansRequestSchema,
  AuroraPlansResponseSchema,
  AuroraPortalRequestSchema,
  AuroraPortalResponseSchema,
  AuroraSessionSchema,
  AuroraTopUpRequestSchema,
  AuroraTopUpResponseSchema,
  AuroraWalletSchema,
  CreditAmountSchema,
  type AuroraCheckoutRequestDto,
  type AuroraCheckoutResponseDto,
  type AuroraCommerceErrorDto,
  type AuroraLedgerEntryDto,
  type AuroraLedgerRequestDto,
  type AuroraLedgerResponseDto,
  type AuroraPlanDto,
  type AuroraPlansRequestDto,
  type AuroraPlansResponseDto,
  type AuroraPortalRequestDto,
  type AuroraPortalResponseDto,
  type AuroraSessionDto,
  type AuroraTopUpRequestDto,
  type AuroraTopUpResponseDto,
  type AuroraWalletDto,
  type CreditAmount,
} from '../src/index.js';

const monthlyPlan = {
  id: 'starter-monthly',
  name: 'Starter',
  billingInterval: 'month',
  displayPrice: '$12.00',
  currency: 'USD',
  credits: '120.00',
} as const satisfies AuroraPlanDto;

const ledgerEntry = {
  id: 'ledger-1',
  amount: '12.50',
  direction: 'credit',
  createdAt: '2026-09-01T00:00:00.000Z',
} as const satisfies AuroraLedgerEntryDto;

describe('Aurora value contracts', () => {
  it('keeps credit amounts as unsigned decimal strings with at most two fractional digits', () => {
    const amount = '12.50' satisfies CreditAmount;

    expect(CreditAmountSchema.parse(amount)).toBe('12.50');
    expect(CreditAmountSchema.parse('0')).toBe('0');
    expect(CreditAmountSchema.parse('1.2')).toBe('1.2');
    expect(() => CreditAmountSchema.parse(12.5)).toThrow();
    expect(() => CreditAmountSchema.parse('-1.00')).toThrow();
    expect(() => CreditAmountSchema.parse('1.234')).toThrow();
    expect(() => CreditAmountSchema.parse('.50')).toThrow();
  });

  it('validates session DTOs and rejects invalid or undeclared fields', () => {
    const session = {
      authenticated: true,
      accountId: 'acct-1',
    } satisfies AuroraSessionDto;

    expect(AuroraSessionSchema.parse(session)).toEqual(session);
    expect(AuroraSessionSchema.parse({ authenticated: false, accountId: null })).toEqual({
      authenticated: false,
      accountId: null,
    });
    expect(() => AuroraSessionSchema.parse({ authenticated: 'yes', accountId: null })).toThrow();
    expect(() =>
      AuroraSessionSchema.parse({ authenticated: true, accountId: 'acct-1', tenantId: 'tenant-1' }),
    ).toThrow();
  });

  it('validates server-owned plan fields and every supported billing interval', () => {
    expect(AuroraPlanSchema.parse(monthlyPlan)).toEqual(monthlyPlan);
    expect(
      AuroraPlanSchema.parse({ ...monthlyPlan, id: 'annual', billingInterval: 'year' }),
    ).toMatchObject({ billingInterval: 'year' });
    expect(
      AuroraPlanSchema.parse({ ...monthlyPlan, id: 'credits-100', billingInterval: 'top-up' }),
    ).toMatchObject({ billingInterval: 'top-up' });
    expect(() => AuroraPlanSchema.parse({ ...monthlyPlan, billingInterval: 'week' })).toThrow();
    expect(() => AuroraPlanSchema.parse({ ...monthlyPlan, credits: 120 })).toThrow();
    expect(() => AuroraPlanSchema.parse({ ...monthlyPlan, priceInCents: 1200 })).toThrow();
  });

  it('validates wallets without coercing decimal credit values', () => {
    const wallet = {
      availableCredits: '12.50',
      reservedCredits: '2.00',
    } satisfies AuroraWalletDto;

    expect(AuroraWalletSchema.parse(wallet)).toEqual(wallet);
    expect(() =>
      AuroraWalletSchema.parse({ availableCredits: 12.5, reservedCredits: '0' }),
    ).toThrow();
    expect(() =>
      AuroraWalletSchema.parse({ ...wallet, lifetimeCredits: '100.00' }),
    ).toThrow();
  });

  it('validates immutable ledger-entry facts', () => {
    expect(AuroraLedgerEntrySchema.parse(ledgerEntry)).toEqual(ledgerEntry);
    expect(
      AuroraLedgerEntrySchema.parse({ ...ledgerEntry, id: 'ledger-2', direction: 'debit' }),
    ).toMatchObject({ direction: 'debit' });
    expect(() => AuroraLedgerEntrySchema.parse({ ...ledgerEntry, direction: 'refund' })).toThrow();
    expect(() => AuroraLedgerEntrySchema.parse({ ...ledgerEntry, amount: '-1.00' })).toThrow();
    expect(() => AuroraLedgerEntrySchema.parse({ ...ledgerEntry, createdAt: 1_788_220_800 })).toThrow();
  });

  it('validates structured commerce errors with the allowed HTTP statuses only', () => {
    const error = {
      code: 'insufficient_credits',
      message: 'Not enough credits are available.',
    } as const;

    for (const status of [401, 402, 409] as const) {
      const commerceError = { ...error, status } satisfies AuroraCommerceErrorDto;
      expect(AuroraCommerceErrorSchema.parse(commerceError)).toEqual(commerceError);
    }

    expect(() => AuroraCommerceErrorSchema.parse({ ...error, status: 400 })).toThrow();
    expect(() =>
      AuroraCommerceErrorSchema.parse({ ...error, status: 402, retryable: false }),
    ).toThrow();
  });
});

describe('Aurora read endpoint contracts', () => {
  it('uses a strict empty request and plan DTO array for plans', () => {
    const request = {} satisfies AuroraPlansRequestDto;
    const response = [monthlyPlan] satisfies AuroraPlansResponseDto;

    expect(AuroraPlansRequestSchema.parse(request)).toEqual({});
    expect(AuroraPlansResponseSchema.parse(response)).toEqual(response);
    expect(() => AuroraPlansRequestSchema.parse({ accountId: 'acct-1' })).toThrow();
    expect(() => AuroraPlansResponseSchema.parse({ plans: response })).toThrow();
    expect(() => AuroraPlansResponseSchema.parse([{ ...monthlyPlan, credits: 120 }])).toThrow();
  });

  it('uses a strict empty request and ledger-entry DTO array for ledger reads', () => {
    const request = {} satisfies AuroraLedgerRequestDto;
    const response = [ledgerEntry] satisfies AuroraLedgerResponseDto;

    expect(AuroraLedgerRequestSchema.parse(request)).toEqual({});
    expect(AuroraLedgerResponseSchema.parse(response)).toEqual(response);
    expect(() => AuroraLedgerRequestSchema.parse({ cursor: 'next' })).toThrow();
    expect(() => AuroraLedgerResponseSchema.parse({ entries: response })).toThrow();
    expect(() => AuroraLedgerResponseSchema.parse([{ ...ledgerEntry, direction: 'refund' }])).toThrow();
  });
});

describe('Aurora mutation endpoint contracts', () => {
  it('accepts only a plan and recurring interval for checkout', () => {
    const request = {
      planId: 'starter-monthly',
      billingInterval: 'month',
    } satisfies AuroraCheckoutRequestDto;
    const response = {
      url: 'https://billing.example.test/checkout/session-1',
    } satisfies AuroraCheckoutResponseDto;

    expect(AuroraCheckoutRequestSchema.parse(request)).toEqual(request);
    expect(AuroraCheckoutResponseSchema.parse(response)).toEqual(response);
    expect(
      AuroraCheckoutRequestSchema.parse({ ...request, billingInterval: 'year' }),
    ).toMatchObject({ billingInterval: 'year' });
    expect(() => AuroraCheckoutRequestSchema.parse({ ...request, billingInterval: 'top-up' })).toThrow();
    expect(() => AuroraCheckoutRequestSchema.parse({ ...request, accountId: 'acct-1' })).toThrow();
    expect(() => AuroraCheckoutResponseSchema.parse({ url: 'not-a-url' })).toThrow();
    expect(() =>
      AuroraCheckoutResponseSchema.parse({ ...response, checkoutSessionId: 'session-1' }),
    ).toThrow();
  });

  it('accepts only a server-owned plan id for top-up', () => {
    const request = { planId: 'credits-100' } satisfies AuroraTopUpRequestDto;
    const response = {
      url: 'https://billing.example.test/top-up/session-1',
    } satisfies AuroraTopUpResponseDto;

    expect(AuroraTopUpRequestSchema.parse(request)).toEqual(request);
    expect(AuroraTopUpResponseSchema.parse(response)).toEqual(response);
    expect(() => AuroraTopUpRequestSchema.parse({ ...request, amount: '100.00' })).toThrow();
    expect(() => AuroraTopUpRequestSchema.parse({})).toThrow();
    expect(() => AuroraTopUpResponseSchema.parse({ url: 42 })).toThrow();
    expect(() => AuroraTopUpResponseSchema.parse({ ...response, credits: '100.00' })).toThrow();
  });

  it('uses a strict empty portal request and a URL response', () => {
    const request = {} satisfies AuroraPortalRequestDto;
    const response = {
      url: 'https://billing.example.test/portal/session-1',
    } satisfies AuroraPortalResponseDto;

    expect(AuroraPortalRequestSchema.parse(request)).toEqual({});
    expect(AuroraPortalResponseSchema.parse(response)).toEqual(response);
    expect(() => AuroraPortalRequestSchema.parse({ returnUrl: 'https://example.test' })).toThrow();
    expect(() => AuroraPortalResponseSchema.parse({ redirectUrl: response.url })).toThrow();
    expect(() =>
      AuroraPortalResponseSchema.parse({ ...response, returnUrl: 'https://example.test/account' }),
    ).toThrow();
  });
});
