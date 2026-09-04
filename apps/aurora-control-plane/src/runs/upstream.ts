import { createHash } from 'node:crypto';

/** SHA-256 hex digest over the exact outgoing upstream body bytes. */
export function digestAuroraRunBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export type UpstreamOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly bodyText: string }
  | { readonly kind: 'lost' };

export interface OpenDesignUpstream {
  /**
   * POST the exact body bytes to OpenDesign's `POST /api/runs` (its
   * createOrReuse entry point). A complete HTTP response — any status — is
   * returned as received. A response lost on an uncertain network is retried
   * exactly once with byte-identical body against the same idempotent
   * identity; a second loss is reported as `lost`, never retried again.
   */
  createOrReuseRun(body: string): Promise<UpstreamOutcome>;
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

  return {
    async createOrReuseRun(body) {
      const first = await attempt(body);
      if (first.kind === 'response') {
        return first;
      }
      return attempt(body);
    },
  };
}
