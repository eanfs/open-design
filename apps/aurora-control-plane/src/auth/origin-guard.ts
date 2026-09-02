import type { NextFunction, Request, Response } from 'express';

/**
 * A mutation request passes when it presents no `Origin` header (non-browser
 * client) or an `Origin` that matches the configured public origin exactly.
 * Browsers always attach `Origin` to cross-origin and same-origin POSTs, so a
 * mismatching value identifies a cross-site submission. This guard never
 * relies on CORS preflight.
 */
export function isSameOriginSubmission(
  publicOrigin: string,
  originHeader: string | undefined,
): boolean {
  if (originHeader === undefined) return true;
  try {
    return new URL(originHeader).origin === new URL(publicOrigin).origin;
  } catch {
    return false;
  }
}

export function requireSameOriginMutation(publicOrigin: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!isSameOriginSubmission(publicOrigin, request.headers.origin)) {
      response.status(403).json({ error: 'cross_origin_forbidden' });
      return;
    }
    next();
  };
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Router-wide invariant: every state-changing request (`POST`, `PUT`,
 * `PATCH`, `DELETE`) on a router using this middleware must be same-origin,
 * so new mutation routes inherit CSRF protection structurally instead of
 * remembering to attach `requireSameOriginMutation` per route.
 */
export function requireSameOriginForMutations(publicOrigin: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }
    if (!isSameOriginSubmission(publicOrigin, request.headers.origin)) {
      response.status(403).json({ error: 'cross_origin_forbidden' });
      return;
    }
    next();
  };
}
