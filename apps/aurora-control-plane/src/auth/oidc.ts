import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from 'openid-client';

import type { AuroraConfig } from '../config.js';

export const AURORA_LOGIN_COOKIE_NAME = '__Host-aurora_login';
export const AURORA_SESSION_COOKIE_NAME = '__Host-aurora_session';

/** State bound to a single authorization request; carried in the signed login cookie. */
export interface AuroraLoginChallenge {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly expiresAtMs: number;
}

/** Public and server-side facts resolved from a completed OIDC login. */
export interface AuroraOidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAt: number | null;
}

export class AuroraLoginError extends Error {
  constructor(
    readonly code: 'aurora_login_state_invalid' | 'aurora_oidc_rejected',
    message: string,
  ) {
    super(message);
    this.name = 'AuroraLoginError';
  }
}

const providerConfigurations = new WeakMap<AuroraConfig, Promise<Configuration>>();

/**
 * Resolve (and memoize per config object) the OIDC provider metadata via
 * discovery. Failures are evicted so a later request can retry.
 */
export function auroraOidcConfiguration(config: AuroraConfig): Promise<Configuration> {
  const cached = providerConfigurations.get(config);
  if (cached !== undefined) return cached;
  const options =
    config.oidc.allowInsecureHttp === true ? { execute: [allowInsecureRequests] } : undefined;
  const pending = discovery(
    new URL(config.oidc.issuer),
    config.oidc.clientId,
    config.oidc.clientSecret,
    undefined,
    options,
  ).catch((error: unknown) => {
    providerConfigurations.delete(config);
    throw error;
  });
  providerConfigurations.set(config, pending);
  return pending;
}

function signLoginChallenge(secret: string, challenge: AuroraLoginChallenge): string {
  const payload = Buffer.from(JSON.stringify(challenge), 'utf8');
  const mac = createHmac('sha256', secret).update(payload).digest();
  return `${payload.toString('base64url')}.${mac.toString('base64url')}`;
}

function verifyLoginChallenge(
  secret: string,
  cookieValue: string | undefined,
): AuroraLoginChallenge | null {
  if (cookieValue === undefined) return null;
  const dot = cookieValue.indexOf('.');
  if (dot <= 0 || dot === cookieValue.length - 1) return null;
  const payloadB64 = cookieValue.slice(0, dot);
  const macB64 = cookieValue.slice(dot + 1);
  const expectedMac = createHmac('sha256', secret)
    .update(Buffer.from(payloadB64, 'base64url'))
    .digest();
  let actualMac: Buffer;
  try {
    actualMac = Buffer.from(macB64, 'base64url');
  } catch {
    return null;
  }
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const challenge = parsed as Record<string, unknown>;
  if (
    typeof challenge.state !== 'string' ||
    typeof challenge.nonce !== 'string' ||
    typeof challenge.codeVerifier !== 'string' ||
    typeof challenge.expiresAtMs !== 'number' ||
    challenge.expiresAtMs <= Date.now()
  ) {
    return null;
  }
  return {
    state: challenge.state,
    nonce: challenge.nonce,
    codeVerifier: challenge.codeVerifier,
    expiresAtMs: challenge.expiresAtMs,
  };
}

export interface AuroraLoginRequest {
  readonly redirectUrl: URL;
  readonly loginCookieValue: string;
  readonly loginCookieMaxAgeSeconds: number;
}

/** Build an Authorization Code + PKCE redirect and the signed login-state cookie for it. */
export async function beginAuroraLogin(config: AuroraConfig): Promise<AuroraLoginRequest> {
  const provider = await auroraOidcConfiguration(config);
  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const redirectUrl = buildAuthorizationUrl(provider, {
    redirect_uri: `${config.publicOrigin}/api/aurora/callback`,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const challenge: AuroraLoginChallenge = {
    state,
    nonce,
    codeVerifier,
    expiresAtMs: Date.now() + config.loginStateTtlSeconds * 1000,
  };
  return {
    redirectUrl,
    loginCookieValue: signLoginChallenge(config.loginStateSigningSecret, challenge),
    loginCookieMaxAgeSeconds: config.loginStateTtlSeconds,
  };
}

/**
 * Verify the login cookie, require the callback state to match, and exchange
 * the authorization code with PKCE and nonce validation. Tokens are returned
 * to the caller for server-side persistence only.
 */
export async function completeAuroraLogin(
  config: AuroraConfig,
  callbackUrl: URL,
  loginCookieValue: string | undefined,
): Promise<AuroraOidcIdentity> {
  const challenge = verifyLoginChallenge(config.loginStateSigningSecret, loginCookieValue);
  if (challenge === null) {
    throw new AuroraLoginError(
      'aurora_login_state_invalid',
      'The OIDC login state is missing, forged, or expired',
    );
  }
  const provider = await auroraOidcConfiguration(config);
  const tokens = await authorizationCodeGrant(provider, callbackUrl, {
    pkceCodeVerifier: challenge.codeVerifier,
    expectedState: challenge.state,
    expectedNonce: challenge.nonce,
  });
  const claims = tokens.claims();
  if (claims === undefined) {
    throw new AuroraLoginError(
      'aurora_oidc_rejected',
      'The OIDC provider response did not include an ID token',
    );
  }
  return {
    issuer: claims.iss,
    subject: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    displayName: typeof claims.name === 'string' ? claims.name : null,
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    idToken: tokens.id_token ?? null,
    expiresAt: typeof tokens.expires_at === 'number' ? tokens.expires_at : null,
  };
}
