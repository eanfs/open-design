import { createHash } from 'node:crypto';

/**
 * The only runtime admitted for paid runs (DSH-only, issue #13). A paid-run
 * body that explicitly names any other agent is rejected before credits are
 * reserved; an omitted agentId is filled with this value before the body
 * leaves the control plane.
 */
export const AURORA_RUN_AGENT_ID = 'deepseek-harness';

/** SHA-256 hex digest over the exact outgoing upstream body bytes. */
export function digestAuroraRunBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export type UpstreamOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly bodyText: string }
  | { readonly kind: 'lost' };

/**
 * Outcome of reading one run's status from OpenDesign's `GET /api/runs/:id`.
 * A 200 with a string `status` field is reported verbatim (the reconciler
 * normalizes spellings); a deterministic 404 means the run no longer exists
 * upstream; everything uncertain — network loss, 5xx, unparseable body — is
 * `unavailable` and retried on the next reconciliation pass.
 */
export type RunStatusFetchOutcome =
  | { readonly kind: 'status'; readonly rawStatus: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' };

export interface OpenDesignUpstream {
  /**
   * POST the exact body bytes to OpenDesign's `POST /api/runs` (its
   * createOrReuse entry point). A complete HTTP response — any status — is
   * returned as received. A response lost on an uncertain network is retried
   * exactly once with byte-identical body against the same idempotent
   * identity; a second loss is reported as `lost`, never retried again.
   */
  createOrReuseRun(body: string): Promise<UpstreamOutcome>;
  /**
   * GET the run's current status from OpenDesign's `GET /api/runs/:id`.
   * An uncertain outcome is retried exactly once, mirroring
   * `createOrReuseRun`; a deterministic outcome (200 status, 404) is never
   * re-attempted within one poll.
   */
  fetchRunStatus(runId: string): Promise<RunStatusFetchOutcome>;
}

export function createOpenDesignUpstream(options: {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}): OpenDesignUpstream {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  const attempt = async (body: string): Promise<UpstreamOutcome> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch {
      return { kind: 'lost' };
    }
    try {
      return { kind: 'response', status: response.status, bodyText: await response.text() };
    } catch {
      return { kind: 'lost' };
    }
  };

  const attemptStatus = async (runId: string): Promise<RunStatusFetchOutcome> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
    } catch {
      return { kind: 'unavailable' };
    }
    if (response.status === 404) {
      return { kind: 'not-found' };
    }
    if (response.status < 200 || response.status >= 300) {
      return { kind: 'unavailable' };
    }
    try {
      const payload = (await response.json()) as { status?: unknown };
      if (typeof payload.status === 'string') {
        return { kind: 'status', rawStatus: payload.status };
      }
    } catch {
      // Fall through to unavailable on an unparseable body.
    }
    return { kind: 'unavailable' };
  };

  return {
    async createOrReuseRun(body) {
      const first = await attempt(body);
      if (first.kind === 'response') {
        return first;
      }
      return attempt(body);
    },
    async fetchRunStatus(runId) {
      const first = await attemptStatus(runId);
      if (first.kind !== 'unavailable') {
        return first;
      }
      return attemptStatus(runId);
    },
  };
}
