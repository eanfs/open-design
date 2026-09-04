import type { Request } from 'express';

import { AURORA_SESSION_COOKIE_NAME } from './oidc.js';
import type { AuroraPrincipal, AuroraSessionStore } from './session-store.js';

/** Read a single cookie value from a `Cookie` header, or undefined when absent. */
export function readAuroraCookie(
  headerValue: string | undefined,
  name: string,
): string | undefined {
  if (headerValue === undefined) return undefined;
  for (const part of headerValue.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const raw = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      // A hostile cookie value that is not valid percent-encoding is treated
      // as absent rather than crashing the request with a URIError.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Resolve the session cookie into a principal, or null when the request
 * carries no valid unexpired session. Shared by the control-plane routes and
 * the tenant gateway proxy so both surfaces authenticate identically.
 */
export async function resolveAuroraSession(
  store: AuroraSessionStore,
  request: Request,
): Promise<AuroraPrincipal | null> {
  const token = readAuroraCookie(request.headers.cookie, AURORA_SESSION_COOKIE_NAME);
  return token === undefined ? null : await store.get(token);
}
