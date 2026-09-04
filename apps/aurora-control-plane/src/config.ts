export interface AuroraOidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Test-only escape hatch that permits an `http://` issuer. Production
   * issuers must be served over HTTPS; leaving this unset keeps the
   * openid-client TLS-only guarantees intact.
   */
  readonly allowInsecureHttp?: boolean;
}

export interface AuroraStripeConfig {
  readonly secretKey: string;
  /** Signing secret for `POST /api/aurora/webhooks/stripe` deliveries. */
  readonly webhookSecret: string;
  /**
   * Test-only escape hatch that points the Stripe client at a local fake.
   * Production must leave these unset so the official `https://api.stripe.com`
   * endpoint is used.
   */
  readonly apiProtocol?: 'http' | 'https';
  readonly apiHost?: string;
  readonly apiPort?: number;
}

export interface AuroraRunsConfig {
  /** Base URL of the tenant's OpenDesign instance that admitted runs target. */
  readonly upstreamBaseUrl: string;
  /**
   * Poll cadence for settlement reconciliation of reserved run charges.
   * Falls back to the reconciler default when unset.
   */
  readonly reconcileIntervalMs?: number;
}

export interface AuroraConfig {
  readonly host: string;
  readonly port: number;
  /** Origin browsers use to reach this control plane; used for CSRF checks and redirect URIs. */
  readonly publicOrigin: string;
  readonly oidc: AuroraOidcConfig;
  readonly sessionTtlSeconds: number;
  readonly loginStateTtlSeconds: number;
  /** HMAC key protecting the short-lived OIDC login-state cookie. */
  readonly loginStateSigningSecret: string;
  readonly stripe: AuroraStripeConfig;
  /**
   * Paid-run admission target; present only on control planes that admit
   * runs. The fixed run price itself lives in `runs/admission.ts` as the
   * single versioned server-side constant.
   */
  readonly runs?: AuroraRunsConfig;
}
