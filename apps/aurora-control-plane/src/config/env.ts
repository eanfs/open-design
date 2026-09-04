import type { AuroraConfig } from '../config.js';

export interface AuroraBootstrapConfig {
  readonly app: AuroraConfig;
  /** PostgreSQL connection string the control plane uses for its schema. */
  readonly databaseUrl: string;
}

const ENV_PREFIX = 'AURORA_';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[`${ENV_PREFIX}${name}`];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${ENV_PREFIX}${name}`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[`${ENV_PREFIX}${name}`];
  return value === undefined || value === '' ? undefined : value;
}

function optionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  range?: { readonly min: number; readonly max?: number },
): number {
  const value = optional(env, name);
  if (value === undefined) return fallback;
  // The whole string must be an integer: parseInt would silently accept
  // "3000junk" as 3000 and "1.5" as 1, hiding operator mistakes at boot.
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${ENV_PREFIX}${name} must be a non-negative integer, got "${value}"`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${ENV_PREFIX}${name} is out of range: "${value}"`);
  }
  if (
    range !== undefined &&
    (parsed < range.min || (range.max !== undefined && parsed > range.max))
  ) {
    throw new Error(
      `${ENV_PREFIX}${name} must be within [${range.min}, ${range.max ?? '∞'}], got "${value}"`,
    );
  }
  return parsed;
}

function optionalBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = optional(env, name);
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error(`${ENV_PREFIX}${name} must be 1/true or 0/false, got "${value}"`);
}

function optionalEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = optional(env, name);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new Error(
      `${ENV_PREFIX}${name} must be one of ${allowed.join('/')}, got "${value}"`,
    );
  }
  return value as T;
}

/**
 * Build the control-plane configuration strictly from environment variables.
 * Required values fail loudly at boot so a misconfigured deployment cannot
 * start half-configured; optional test-only escape hatches stay unset in
 * production.
 */
export function loadAuroraConfigFromEnv(env: NodeJS.ProcessEnv): AuroraBootstrapConfig {
  const apiProtocol = optionalEnum(env, 'STRIPE_API_PROTOCOL', ['http', 'https']);
  const apiHost = optional(env, 'STRIPE_API_HOST');
  const allowInsecureHttp = optionalBoolean(env, 'OIDC_ALLOW_INSECURE_HTTP');
  const app: AuroraConfig = {
    host: optional(env, 'HOST') ?? '0.0.0.0',
    port: optionalInteger(env, 'PORT', 3000, { min: 1, max: 65535 }),
    publicOrigin: required(env, 'PUBLIC_ORIGIN'),
    oidc: {
      issuer: required(env, 'OIDC_ISSUER'),
      clientId: required(env, 'OIDC_CLIENT_ID'),
      clientSecret: required(env, 'OIDC_CLIENT_SECRET'),
      ...(allowInsecureHttp === undefined ? {} : { allowInsecureHttp }),
    },
    sessionTtlSeconds: optionalInteger(env, 'SESSION_TTL_SECONDS', 3600, { min: 1 }),
    loginStateTtlSeconds: optionalInteger(env, 'LOGIN_STATE_TTL_SECONDS', 600, { min: 1 }),
    loginStateSigningSecret: required(env, 'LOGIN_STATE_SIGNING_SECRET'),
    stripe: {
      secretKey: required(env, 'STRIPE_SECRET_KEY'),
      webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
      ...(apiProtocol === undefined ? {} : { apiProtocol }),
      ...(apiHost === undefined ? {} : { apiHost }),
      ...(optional(env, 'STRIPE_API_PORT') === undefined
        ? {}
        : { apiPort: optionalInteger(env, 'STRIPE_API_PORT', 0, { min: 1, max: 65535 }) }),
    },
  };
  return { app, databaseUrl: required(env, 'DATABASE_URL') };
}
