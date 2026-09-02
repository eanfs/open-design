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
}
