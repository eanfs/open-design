import { AuroraPlanSchema, type AuroraPlanDto } from '@open-design/aurora-contracts';

/**
 * The server-owned pricing catalog. Plans, billing intervals, Stripe price
 * ids, and credit grants exist ONLY here: browser input never names a price,
 * and web responses carry display values but never the Stripe references or
 * credit rules behind them.
 */
export type AuroraPlanId = 'creator' | 'pro' | 'studio';
export type AuroraBillingInterval = 'month' | 'year' | 'top-up';

export interface ServerPlan {
  id: AuroraPlanId;
  interval: AuroraBillingInterval;
  stripePriceId: string;
  credits: string;
  pricingVersion: string;
}

const AURORA_PRICING_VERSION = '2026-09';

export const AURORA_CATALOG: readonly ServerPlan[] = [
  { id: 'creator', interval: 'month', stripePriceId: 'price_creator_month_usd', credits: '120.00', pricingVersion: AURORA_PRICING_VERSION },
  { id: 'creator', interval: 'year', stripePriceId: 'price_creator_year_usd', credits: '1440.00', pricingVersion: AURORA_PRICING_VERSION },
  { id: 'creator', interval: 'top-up', stripePriceId: 'price_creator_topup_usd', credits: '50.00', pricingVersion: AURORA_PRICING_VERSION },
  { id: 'pro', interval: 'month', stripePriceId: 'price_pro_month_usd', credits: '400.00', pricingVersion: AURORA_PRICING_VERSION },
  { id: 'pro', interval: 'year', stripePriceId: 'price_pro_year_usd', credits: '4800.00', pricingVersion: AURORA_PRICING_VERSION },
  { id: 'pro', interval: 'top-up', stripePriceId: 'price_pro_topup_usd', credits: '150.00', pricingVersion: AURORA_PRICING_VERSION },
  { id: 'studio', interval: 'month', stripePriceId: 'price_studio_month_usd', credits: '1200.00', pricingVersion: AURORA_PRICING_VERSION },
  { id: 'studio', interval: 'year', stripePriceId: 'price_studio_year_usd', credits: '14400.00', pricingVersion: AURORA_PRICING_VERSION },
  { id: 'studio', interval: 'top-up', stripePriceId: 'price_studio_topup_usd', credits: '500.00', pricingVersion: AURORA_PRICING_VERSION },
];

interface PlanDisplay {
  readonly name: string;
  readonly displayPrice: string;
  readonly currency: string;
}

const PLAN_DISPLAY: Readonly<Record<string, PlanDisplay>> = {
  'creator:month': { name: 'Creator Monthly', displayPrice: '$19', currency: 'usd' },
  'creator:year': { name: 'Creator Yearly', displayPrice: '$190', currency: 'usd' },
  'creator:top-up': { name: 'Creator Credit Pack', displayPrice: '$10', currency: 'usd' },
  'pro:month': { name: 'Pro Monthly', displayPrice: '$49', currency: 'usd' },
  'pro:year': { name: 'Pro Yearly', displayPrice: '$490', currency: 'usd' },
  'pro:top-up': { name: 'Pro Credit Pack', displayPrice: '$25', currency: 'usd' },
  'studio:month': { name: 'Studio Monthly', displayPrice: '$119', currency: 'usd' },
  'studio:year': { name: 'Studio Yearly', displayPrice: '$1190', currency: 'usd' },
  'studio:top-up': { name: 'Studio Credit Pack', displayPrice: '$75', currency: 'usd' },
};

const CATALOG_BY_KEY = new Map(AURORA_CATALOG.map((plan) => [`${plan.id}:${plan.interval}`, plan]));

export function findAuroraSubscriptionPlan(
  id: string,
  interval: 'month' | 'year',
): ServerPlan | null {
  return CATALOG_BY_KEY.get(`${id}:${interval}`) ?? null;
}

export function findAuroraTopUpPlan(id: string): ServerPlan | null {
  return CATALOG_BY_KEY.get(`${id}:top-up`) ?? null;
}

function displayFor(plan: ServerPlan): PlanDisplay {
  const display = PLAN_DISPLAY[`${plan.id}:${plan.interval}`];
  if (display === undefined) {
    throw new Error(`Aurora catalog is missing display metadata for ${plan.id}:${plan.interval}`);
  }
  return display;
}

/** Display-only catalog projection for the web; never carries Stripe price ids. */
export function listAuroraPlanDtos(): AuroraPlanDto[] {
  return AURORA_CATALOG.map((plan) => {
    const display = displayFor(plan);
    return AuroraPlanSchema.parse({
      id: plan.id,
      name: display.name,
      billingInterval: plan.interval,
      displayPrice: display.displayPrice,
      currency: display.currency,
      credits: plan.credits,
    });
  });
}
