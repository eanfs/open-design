import {
  AuroraCommerceErrorSchema,
  type AuroraCommerceErrorDto,
} from '@open-design/aurora-contracts';

/**
 * Statuses the Aurora commerce error contract knows how to express. The web
 * error path branches on these: 401 sends the user to sign in, 402 to
 * top-up, 409 reports a request or agent conflict. Everything else that
 * fails on a paid-run route is either a verbatim upstream failure or an
 * infrastructure fault and deliberately does not pretend to be a commerce
 * error.
 */
export type AuroraCommerceErrorStatus = 401 | 402 | 409;

/**
 * Build a commerce error body through `AuroraCommerceErrorSchema`, so every
 * body a route emits is schema-valid by construction: a typo in the status
 * or a missing field fails here at the call site instead of shipping an
 * out-of-contract response to the browser.
 */
export function toAuroraCommerceErrorBody(
  status: AuroraCommerceErrorStatus,
  code: string,
  message: string,
): AuroraCommerceErrorDto {
  return AuroraCommerceErrorSchema.parse({ status, code, message });
}
