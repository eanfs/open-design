import { describe, expect, it } from 'vitest';

import { loadAuroraConfigFromEnv } from '../src/config/env.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  AURORA_PUBLIC_ORIGIN: 'https://aurora.example.com',
  AURORA_OIDC_ISSUER: 'https://issuer.example.com',
  AURORA_OIDC_CLIENT_ID: 'aurora-web',
  AURORA_OIDC_CLIENT_SECRET: 'secret',
  AURORA_LOGIN_STATE_SIGNING_SECRET: 'signing-secret',
  AURORA_STRIPE_SECRET_KEY: 'sk_test_aurora',
  AURORA_STRIPE_WEBHOOK_SECRET: 'whsec_aurora',
  AURORA_DATABASE_URL: 'postgres://aurora:aurora@db:5432/aurora',
};

describe('loadAuroraConfigFromEnv', () => {
  it('loads required values and applies defaults', () => {
    const { app, databaseUrl } = loadAuroraConfigFromEnv({ ...BASE_ENV });

    expect(databaseUrl).toBe(BASE_ENV.AURORA_DATABASE_URL);
    expect(app.host).toBe('0.0.0.0');
    expect(app.port).toBe(3000);
    expect(app.publicOrigin).toBe('https://aurora.example.com');
    expect(app.sessionTtlSeconds).toBe(3600);
    expect(app.loginStateTtlSeconds).toBe(600);
    expect(app.oidc.allowInsecureHttp).toBeUndefined();
    expect(app.stripe.apiProtocol).toBeUndefined();
    expect(app.stripe.apiHost).toBeUndefined();
  });

  it('parses optional tunables and test-only escape hatches', () => {
    const { app } = loadAuroraConfigFromEnv({
      ...BASE_ENV,
      AURORA_HOST: '127.0.0.1',
      AURORA_PORT: '8080',
      AURORA_SESSION_TTL_SECONDS: '120',
      AURORA_OIDC_ALLOW_INSECURE_HTTP: '1',
      AURORA_STRIPE_API_PROTOCOL: 'http',
      AURORA_STRIPE_API_HOST: '127.0.0.1',
      AURORA_STRIPE_API_PORT: '12111',
    });

    expect(app.host).toBe('127.0.0.1');
    expect(app.port).toBe(8080);
    expect(app.sessionTtlSeconds).toBe(120);
    expect(app.oidc.allowInsecureHttp).toBe(true);
    expect(app.stripe.apiProtocol).toBe('http');
    expect(app.stripe.apiHost).toBe('127.0.0.1');
    expect(app.stripe.apiPort).toBe(12111);
  });

  it('fails loudly when a required value is missing or empty', () => {
    expect(() => loadAuroraConfigFromEnv({ ...BASE_ENV, AURORA_PUBLIC_ORIGIN: '' })).toThrow(
      /AURORA_PUBLIC_ORIGIN/u,
    );
    expect(() => loadAuroraConfigFromEnv({ ...BASE_ENV, AURORA_OIDC_ISSUER: undefined })).toThrow(
      /AURORA_OIDC_ISSUER/u,
    );
    expect(() => loadAuroraConfigFromEnv({ ...BASE_ENV, AURORA_DATABASE_URL: undefined })).toThrow(
      /AURORA_DATABASE_URL/u,
    );
  });

  it('rejects a non-integer or out-of-range integer value instead of truncating it', () => {
    expect(() => loadAuroraConfigFromEnv({ ...BASE_ENV, AURORA_PORT: '3000junk' })).toThrow(
      /AURORA_PORT must be a non-negative integer/u,
    );
    expect(() =>
      loadAuroraConfigFromEnv({ ...BASE_ENV, AURORA_SESSION_TTL_SECONDS: '1.5' }),
    ).toThrow(/AURORA_SESSION_TTL_SECONDS must be a non-negative integer/u);
    expect(() => loadAuroraConfigFromEnv({ ...BASE_ENV, AURORA_PORT: '99999' })).toThrow(
      /AURORA_PORT must be within/u,
    );
  });
});
