/** The shape the API's global error handler returns. Every failure below is built from it. */
interface ErrorEnvelope {
  success?: false;
  error?: {
    code?: string;
    message?: string;
    statusCode?: number;
    requestId?: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Every failure this client throws.
 *
 * `requestId` is the field worth knowing about: it comes back on every response, and quoting it in
 * a support conversation is the difference between "I get a 500" and something answerable.
 */
export class BitelioError extends Error {
  /** HTTP status. `0` when the request never reached the API — a DNS failure, a timeout. */
  readonly status: number;
  /** Machine-readable code, e.g. `VALIDATION_ERROR`. Absent on a transport failure. */
  readonly code: string | undefined;
  /** Quote this when reporting a problem. */
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    init: {status: number; code?: string; requestId?: string; details?: Record<string, unknown>},
  ) {
    super(message);
    this.name = 'BitelioError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
  }

  /** True for the failures a retry could plausibly fix. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  static fromResponse(status: number, requestId: string | undefined, body: unknown): BitelioError {
    const envelope = (body ?? {}) as ErrorEnvelope;
    const error = envelope.error;

    return new BitelioError(error?.message ?? `Request failed with status ${status}`, {
      status,
      code: error?.code,
      // The header wins: the body's copy is absent on responses the API did not build itself,
      // such as a 502 from a proxy in front of it.
      requestId: requestId ?? error?.requestId,
      details: error?.details,
    });
  }
}
