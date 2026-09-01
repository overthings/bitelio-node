import {randomUUID} from 'node:crypto';

import {BitelioError} from './errors.js';

export interface BitelioOptions {
  /**
   * Your project's public key (`pk_…`), needed ONLY by `events.track`.
   *
   * That endpoint authenticates with the public key rather than the secret one — it is the same
   * endpoint browsers and mobile apps post to, and it has no secret-key equivalent that takes an
   * email address. Nothing is lost by supplying it here: a public key is not a secret, it ships in
   * every page of your site.
   */
  publicKey?: string;
  /** Defaults to `https://api.bitelio.com`. Point it at your own deployment if self-hosted. */
  baseUrl?: string;
  /** Per attempt, not for the whole call. Default 30s. */
  timeoutMs?: number;
  /** Retries AFTER the first attempt, on 429 and 5xx only. Default 2. */
  maxRetries?: number;
  /** Swap in a stub in tests, or a proxying fetch in production. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULTS = {
  baseUrl: 'https://api.bitelio.com',
  timeoutMs: 30_000,
  maxRetries: 2,
};

/** Full jitter, capped. Without the jitter a fleet retrying together retries together for ever. */
function backoffMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) return Math.min(retryAfter * 1000, 60_000);
  const ceiling = Math.min(500 * 2 ** attempt, 8_000);
  return Math.random() * ceiling;
}

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  /** Overrides the bearer token for this call. Used by `events.track`, which needs the public key. */
  authToken?: string;
}

/**
 * The transport. Everything a resource does goes through `request`, so the retry policy, the
 * timeout and the error shape are decided in exactly one place.
 */
export class HttpClient {
  private readonly apiKey: string;
  readonly publicKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(apiKey: string, options: BitelioOptions = {}) {
    if (!apiKey) {
      throw new BitelioError('An API key is required. Create one in Settings → General → API Keys.', {status: 0});
    }

    this.apiKey = apiKey;
    this.publicKey = options.publicKey;
    this.baseUrl = (options.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${options.authToken ?? this.apiKey}`,
      accept: 'application/json',
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    // Sent on the FIRST attempt and reused on every retry, which is the entire point: without it
    // the automatic retry below would be a duplicator of transactional email.
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

    let lastError: BitelioError | undefined;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response | undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
      } catch (cause) {
        // Never reached the API: DNS, connection refused, or our own timeout. Status 0 marks the
        // difference, because "the server said no" and "we never asked" want different handling.
        lastError = new BitelioError(
          cause instanceof Error && cause.name === 'AbortError'
            ? `Request to ${method} ${path} timed out after ${this.timeoutMs}ms`
            : `Could not reach the Bitelio API: ${cause instanceof Error ? cause.message : String(cause)}`,
          {status: 0},
        );
      } finally {
        clearTimeout(timer);
      }

      if (response !== undefined) {
        const requestId = response.headers.get('x-request-id') ?? undefined;

        if (response.ok) {
          // 204 has no body to parse, and `response.json()` on an empty one throws.
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }

        const body = await response.json().catch(() => undefined);
        lastError = BitelioError.fromResponse(response.status, requestId, body);

        // 4xx is never retried. A 403 retried three times is a 403 three times slower, and a 400
        // is a bug in the caller that another attempt cannot fix.
        if (!lastError.retryable) throw lastError;
      }

      if (attempt >= this.maxRetries) throw lastError;

      // `Retry-After` when the server sent one, jittered exponential backoff otherwise. One sleep,
      // decided here — an earlier draft of this had two, which silently doubled every wait.
      await sleep(backoffMs(attempt, response ? retryAfterSeconds(response) : null));
    }
  }

  /** A key per call, so the retry above is safe by default rather than by remembering. */
  static newIdempotencyKey(): string {
    return randomUUID();
  }
}
