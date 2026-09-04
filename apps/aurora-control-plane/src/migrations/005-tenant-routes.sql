-- Aurora tenant upstream routing (Task 8).
--
-- Maps an authenticated tenant to the origin of its isolated OpenDesign
-- instance. The browser never supplies this mapping: the gateway resolves the
-- upstream solely from the session's tenant_id, so a browser-submitted
-- upstream URL is ignored by construction. Upstream origins are seeded by the
-- operator (deployment provisioning), never by a runtime endpoint.

CREATE TABLE tenant_routes (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants (id),
  upstream_origin TEXT NOT NULL CHECK (upstream_origin ~ '^https?://'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
