import type { AuroraDatabase } from '../db.js';

/**
 * The authoritative upstream for one tenant. The browser can never choose or
 * influence this value: it is resolved from the authenticated session's
 * tenant id against the operator-seeded `tenant_routes` table.
 */
export interface TenantRoute {
  readonly tenantId: string;
  readonly upstreamOrigin: URL;
}

export interface TenantRouteStore {
  /** Resolve the tenant's upstream, or null when the tenant has no route. */
  getByTenantId(tenantId: string): Promise<TenantRoute | null>;
}

export function createTenantRouteStore(db: AuroraDatabase): TenantRouteStore {
  return {
    async getByTenantId(tenantId) {
      const result = await db.query<{ tenant_id: string; upstream_origin: string }>(
        `SELECT tenant_id, upstream_origin FROM tenant_routes WHERE tenant_id = $1`,
        [tenantId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      // A malformed stored origin throws here and surfaces as a loud server
      // fault instead of silently routing nowhere. Only http(s) upstreams are
      // ever proxied; any other scheme (file:, etc.) is rejected loudly rather
      // than handed to the proxy.
      const origin = new URL(row.upstream_origin);
      if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
        throw new Error(
          `Tenant ${tenantId} has a non-http upstream origin: ${row.upstream_origin}`,
        );
      }
      return { tenantId: row.tenant_id, upstreamOrigin: origin };
    },
  };
}
