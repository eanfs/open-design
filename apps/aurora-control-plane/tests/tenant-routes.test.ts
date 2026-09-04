import { describe, expect, it, vi } from 'vitest';

import type { AuroraDatabase } from '../src/db.js';
import { createTenantRouteStore } from '../src/tenants/routes.js';

function fakeDb(rows: unknown[]): AuroraDatabase {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as AuroraDatabase;
}

describe('createTenantRouteStore', () => {
  it('resolves a tenant to its http upstream', async () => {
    const store = createTenantRouteStore(
      fakeDb([{ tenant_id: 't_1', upstream_origin: 'http://tenant-a:7456' }]),
    );

    const route = await store.getByTenantId('t_1');

    expect(route).toEqual({
      tenantId: 't_1',
      upstreamOrigin: new URL('http://tenant-a:7456'),
    });
  });

  it('returns null for an unknown tenant', async () => {
    const store = createTenantRouteStore(fakeDb([]));

    expect(await store.getByTenantId('t_missing')).toBeNull();
  });

  it('rejects a non-http upstream origin loudly', async () => {
    // Defense in depth over the DB CHECK constraint: a stored non-http origin
    // must surface as a loud server fault, never as a proxied target.
    const store = createTenantRouteStore(
      fakeDb([{ tenant_id: 't_1', upstream_origin: 'file:///etc/passwd' }]),
    );

    await expect(store.getByTenantId('t_1')).rejects.toThrow(/non-http upstream origin/u);
  });
});
