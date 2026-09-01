import {createHmac, timingSafeEqual} from 'node:crypto';

/**
 * Verifying a webhook Bitelio sent you.
 *
 * The signature is HMAC-SHA256 over `{timestamp}.{rawBody}`, sent as `Bitelio-Signature` beside
 * `Bitelio-Timestamp`. The timestamp is inside the signed string so a replayed old request can be
 * rejected — the same scheme Stripe uses, which is deliberate: it is the one developers already
 * know how to verify by hand.
 */

export interface VerifyParams {
  /**
   * The RAW request body, as a string or Buffer — NOT a parsed object.
   *
   * This is the mistake everyone makes. `JSON.parse` then `JSON.stringify` reorders keys and
   * changes whitespace, and the signature covers bytes. In Express, reach for
   * `express.raw({type: 'application/json'})` on the webhook route.
   */
  payload: string | Buffer;
  /** The `Bitelio-Signature` header, verbatim. */
  signature: string;
  /** The `Bitelio-Timestamp` header, verbatim. */
  timestamp: string | number;
  /** Your endpoint's signing secret. */
  secret: string;
  /**
   * How old a request may be, in seconds. Default 300.
   *
   * This is what makes the timestamp worth signing: without a bound, a request captured once can
   * be replayed for ever. Pass `Infinity` only if you have your own replay defence.
   */
  toleranceSeconds?: number;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the length. Comparing
  // the lengths first is safe: a signature's length is not a secret, its content is.
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}

/**
 * True when the request really came from Bitelio and is recent enough.
 *
 * Accepts the request if ANY `v1=` part verifies. There is more than one during a secret
 * rotation — the new secret and the still-live previous one — and a receiver mid-rollover that
 * insisted on a single part would drop half its traffic.
 */
export function verify(params: VerifyParams): boolean {
  const {payload, signature, timestamp, secret, toleranceSeconds = 300} = params;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;

  if (Number.isFinite(toleranceSeconds)) {
    const ageSeconds = Math.abs(Date.now() / 1000 - sentAt);
    if (ageSeconds > toleranceSeconds) return false;
  }

  const body = typeof payload === 'string' ? payload : payload.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${sentAt}.${body}`).digest('hex');

  return signature
    .split(',')
    .map(part => part.trim())
    .filter(part => part.startsWith('v1='))
    .some(part => constantTimeEquals(part.slice('v1='.length), expected));
}

/** `verify`, but it throws instead of returning false — handy at the top of a handler. */
export function assertValid(params: VerifyParams): void {
  if (!verify(params)) {
    throw new Error('Webhook signature verification failed');
  }
}
