import { z } from 'zod';

export const CreditAmountSchema = z.string().regex(/^\d+(?:\.\d{1,2})?$/);

export const AuroraSessionSchema = z
  .object({
    authenticated: z.boolean(),
    accountId: z.string().nullable(),
  })
  .strict();

export const AuroraPlanSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    billingInterval: z.enum(['month', 'year', 'top-up']),
    displayPrice: z.string(),
    currency: z.string(),
    credits: CreditAmountSchema,
  })
  .strict();

export const AuroraWalletSchema = z
  .object({
    availableCredits: CreditAmountSchema,
    reservedCredits: CreditAmountSchema,
  })
  .strict();

export const AuroraLedgerEntrySchema = z
  .object({
    id: z.string(),
    amount: CreditAmountSchema,
    direction: z.enum(['credit', 'debit']),
    createdAt: z.string(),
  })
  .strict();

export const AuroraCommerceErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    status: z.union([z.literal(401), z.literal(402), z.literal(409)]),
  })
  .strict();

export const AuroraPlansRequestSchema = z.object({}).strict();
export const AuroraPlansResponseSchema = z.array(AuroraPlanSchema);

export const AuroraLedgerRequestSchema = z.object({}).strict();
export const AuroraLedgerResponseSchema = z.array(AuroraLedgerEntrySchema);

export const AuroraCheckoutRequestSchema = z
  .object({
    planId: z.string(),
    billingInterval: z.enum(['month', 'year']),
  })
  .strict();
export const AuroraCheckoutResponseSchema = z
  .object({
    url: z.string().url(),
  })
  .strict();

export const AuroraTopUpRequestSchema = z
  .object({
    planId: z.string(),
  })
  .strict();
export const AuroraTopUpResponseSchema = z
  .object({
    url: z.string().url(),
  })
  .strict();

export const AuroraPortalRequestSchema = z.object({}).strict();
export const AuroraPortalResponseSchema = z
  .object({
    url: z.string().url(),
  })
  .strict();

export type CreditAmount = z.infer<typeof CreditAmountSchema>;
export type AuroraSessionDto = z.infer<typeof AuroraSessionSchema>;
export type AuroraPlanDto = z.infer<typeof AuroraPlanSchema>;
export type AuroraWalletDto = z.infer<typeof AuroraWalletSchema>;
export type AuroraLedgerEntryDto = z.infer<typeof AuroraLedgerEntrySchema>;
export type AuroraCommerceErrorDto = z.infer<typeof AuroraCommerceErrorSchema>;
export type AuroraPlansRequestDto = z.infer<typeof AuroraPlansRequestSchema>;
export type AuroraPlansResponseDto = z.infer<typeof AuroraPlansResponseSchema>;
export type AuroraLedgerRequestDto = z.infer<typeof AuroraLedgerRequestSchema>;
export type AuroraLedgerResponseDto = z.infer<typeof AuroraLedgerResponseSchema>;
export type AuroraCheckoutRequestDto = z.infer<typeof AuroraCheckoutRequestSchema>;
export type AuroraCheckoutResponseDto = z.infer<typeof AuroraCheckoutResponseSchema>;
export type AuroraTopUpRequestDto = z.infer<typeof AuroraTopUpRequestSchema>;
export type AuroraTopUpResponseDto = z.infer<typeof AuroraTopUpResponseSchema>;
export type AuroraPortalRequestDto = z.infer<typeof AuroraPortalRequestSchema>;
export type AuroraPortalResponseDto = z.infer<typeof AuroraPortalResponseSchema>;
