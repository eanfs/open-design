# Aurora tenant deployment (reference)

Task 8 of the Aurora Agent Web epic (#5). This directory is the reference
deployment for the Aurora commercial control plane acting as an authenticated
gateway in front of one isolated OpenDesign instance per tenant.

## Topology

```
                 browser (Aurora web shell, Task 10)
                              │  HTTPS
                              ▼
                     ┌──────────────────┐
                     │   control-plane  │  AURORA_PORT (gateway)
                     │  /api/aurora/*   │  ── own commerce routes (OIDC,
                     │  POST /api/runs  │     Stripe, wallet, ledger, paid-run
                     │  opaque proxy    │     admission)
                     └──────┬──────┬────┘
                     tenant-a│      │tenant-b   (isolated networks)
                             ▼      ▼
                     ┌──────────┐ ┌──────────┐
                     │ tenant-a │ │ tenant-b │  standard OpenDesign
                     │ OpenDesign│ │ OpenDesign│  (web + daemon)
                     └──────────┘ └──────────┘
```

- The control plane owns OIDC, Stripe, the wallet, the ledger, paid-run
  admission, and the authoritative tenant→upstream mapping.
- Everything else is **opaque forwarding**: the gateway authenticates the
  session, resolves the upstream solely from the server-side `tenant_routes`
  table, and streams OpenDesign API, SSE, artifact, frame, preview, and
  download traffic through unchanged. It never reimplements an OpenDesign
  protocol, and a browser-submitted upstream URL is ignored by construction.
- `POST /api/runs` is admitted on the gateway (reserve + charge) before the
  opaque proxy is consulted, so a paid run can never bypass admission.

## No DSH-only restriction

Aurora does **not** force a single `deepseek-harness` runtime. Each tenant runs
the standard OpenDesign image and serves whatever agent providers the operator
configures for it; an explicit `agentId` passes through the gateway unchanged
and an omitted one stays omitted. Tenant provider credentials are injected per
tenant (see `env.example`) and never shared.

## Isolation guarantees

- **Data**: each tenant has its own named volume with an explicit
  `OD_DATA_DIR` pointing at the volume mount, so a change in the image workdir
  or launcher cannot silently move tenant data out of the volume. Tenant data
  paths follow the daemon data directory contract in the root `AGENTS.md`; the
  compose mounts the OpenDesign runtime's existing data location per tenant and
  never invents a new path convention.
- **Credentials**: provider credentials are per-tenant environment (see
  "Injecting per-tenant credentials" below); the gateway never exposes them to
  the browser.
- **Network**: each tenant sits on its own network; only the control plane
  bridges them, so browser traffic reaches a tenant only through the
  authenticated gateway. Tenant ports are published on `127.0.0.1` for the
  deployment-seam health checks below.
- **Resources**: per-tenant CPU/memory/PID limits.
- **Tenant API auth**: tenants bind `0.0.0.0` to be reachable by the gateway,
  which the OpenDesign daemon refuses without `OD_API_TOKEN`. Because the
  control plane is the trusted reverse proxy that authenticates every request,
  the reference compose sets `OD_DISABLE_API_AUTH=1` on each tenant; operators
  who prefer a per-tenant token can set `OD_API_TOKEN` instead.

## Injecting per-tenant credentials

Add an `env_file` to each tenant service (or extend its `environment` block)
so provider credentials stay tenant-scoped and are never shared. For example,
with `tenant-a.env` alongside this directory:

```yaml
  tenant-a:
    image: ${OPEN_DESIGN_IMAGE:-ghcr.io/nexu-io/od:latest}
    env_file: ./tenant-a.env
```

`tenant-a.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

> **Production hardening.** This compose is a reference deployment. Before
> serving real traffic:
>
> - Set a strong `AURORA_POSTGRES_PASSWORD` (the `aurora` default is a weak
>   reference value only).
> - Do **not** publish tenant ports (`AURORA_TENANT_A_PORT` / `B_PORT`) on a
>   single-machine production host: a local process that can reach a tenant
>   directly could `POST /api/runs` and bypass the gateway's paid-run
>   admission. Those host-local ports exist solely for the deployment-seam
>   health checks below; in production, keep tenants on their internal
>   networks only and verify through the gateway.
> - The gateway strips the Aurora bearer cookies (`__Host-aurora_session`,
>   `__Host-aurora_login`) from proxied requests and never forwards tenant
>   `Set-Cookie` responses to the browser: tenants share the gateway origin, so
>   tenant cookies would land on the wrong tenant's namespace and could fixate
>   session state. The browser talks to tenants only through the gateway and
>   never needs a tenant's own cookies.
> - The reference build pins `http-proxy@1.18.1` (the last published release).
>   Re-audit this dependency's advisory status when promoting the deployment.

## Provisioning tenant routes

`tenant_routes` is the operator-owned mapping from an authenticated tenant to
its OpenDesign upstream. The control plane applies migrations at boot; the
gateway then resolves upstreams from this table. A tenant with no row gets a
404 (`aurora_tenant_route_missing`) and no traffic is forwarded.

After the stack is up, seed the routes (one row per tenant the operator runs):

```bash
docker compose -f deploy/aurora/docker-compose.yml exec postgres psql \
  -U aurora -d aurora \
  -c "INSERT INTO tenant_routes (tenant_id, upstream_origin)
      VALUES ('<tenant-id>', 'http://tenant-a:7456') ON CONFLICT (tenant_id) DO NOTHING;"
```

Tenant ids are created server-side per OIDC identity (`tenants.id`, prefix
`t_`). For a production deployment the operator provisions tenants and routes
as part of onboarding; an account whose tenant is not routed is rejected
conservatively rather than silently forwarded.

## Running

```bash
cp deploy/aurora/env.example .env        # fill in required values
pnpm tools-dev --version >/dev/null      # ensure the workspace toolchain exists
docker compose -f deploy/aurora/docker-compose.yml up -d --build
```

The control-plane image builds from `deploy/aurora/Dockerfile`; the tenant
instances use the standard `OPEN_DESIGN_IMAGE`.

## Deployment-seam verification

Per the epic's deployment test seam, verify each tenant directly through its
health and agent surfaces:

```bash
curl -s http://127.0.0.1:17456/api/health
curl -s http://127.0.0.1:17456/api/agents
curl -s http://127.0.0.1:17457/api/health
curl -s http://127.0.0.1:17457/api/agents
```

The dual-tenant deployment contract (authenticated routing, cross-tenant
isolation, ignored upstream injection) is exercised by
`e2e/tests/aurora-deployment-contract.test.ts`, which composes the control
plane, PostgreSQL, and two isolated tenant stand-ins through their real HTTP
surfaces.
