import {createHmac} from 'node:crypto';

import {describe, expect, it} from 'vitest';

import {webhooks} from '../src/index.js';

const SECRET = 'whsec_test';
const BODY = '{"type":"email.delivered","data":{"id":"e_1"}}';

/** Exactly what the API's dispatcher builds, so these tests fail if that scheme ever changes. */
function sign(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const now = () => Math.floor(Date.now() / 1000);

describe('webhooks.verify', () => {
  it('accepts a request we really sent', () => {
    const timestamp = now();

    expect(
      webhooks.verify({payload: BODY, signature: sign(SECRET, timestamp, BODY), timestamp, secret: SECRET}),
    ).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    const timestamp = now();
    const signature = sign(SECRET, timestamp, BODY);

    expect(
      webhooks.verify({payload: BODY.replace('e_1', 'e_2'), signature, timestamp, secret: SECRET}),
    ).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const timestamp = now();

    expect(
      webhooks.verify({payload: BODY, signature: sign('whsec_other', timestamp, BODY), timestamp, secret: SECRET}),
    ).toBe(false);
  });

  it('rejects a replay older than the tolerance', () => {
    // The reason the timestamp is inside the signed string at all. Without this bound, a request
    // captured once can be replayed for ever with a signature that still verifies.
    const old = now() - 600;

    expect(webhooks.verify({payload: BODY, signature: sign(SECRET, old, BODY), timestamp: old, secret: SECRET})).toBe(
      false,
    );
  });

  it('accepts an old request when the caller opts out of the bound', () => {
    const old = now() - 600;

    expect(
      webhooks.verify({
        payload: BODY,
        signature: sign(SECRET, old, BODY),
        timestamp: old,
        secret: SECRET,
        toleranceSeconds: Infinity,
      }),
    ).toBe(true);
  });

  it('rejects a timestamp far in the FUTURE too', () => {
    // A clock-skew attack, and the reason the age check uses an absolute value.
    const future = now() + 600;

    expect(
      webhooks.verify({payload: BODY, signature: sign(SECRET, future, BODY), timestamp: future, secret: SECRET}),
    ).toBe(false);
  });

  it('accepts when ANY part verifies, which is what makes a secret rotation survivable', () => {
    // Mid-rollover the dispatcher sends one part per live secret. A receiver that insisted on a
    // single part would drop half its traffic for the length of the rotation.
    const timestamp = now();
    const header = [sign('whsec_old', timestamp, BODY), sign(SECRET, timestamp, BODY)].join(',');

    expect(webhooks.verify({payload: BODY, signature: header, timestamp, secret: SECRET})).toBe(true);
  });

  it('ignores parts with an unknown scheme prefix', () => {
    const timestamp = now();
    const header = `v0=deadbeef,${sign(SECRET, timestamp, BODY)}`;

    expect(webhooks.verify({payload: BODY, signature: header, timestamp, secret: SECRET})).toBe(true);
  });

  it('accepts a Buffer body, which is what a raw body parser hands you', () => {
    const timestamp = now();

    expect(
      webhooks.verify({
        payload: Buffer.from(BODY, 'utf8'),
        signature: sign(SECRET, timestamp, BODY),
        timestamp,
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it('rejects a re-serialised body — the mistake everyone makes', () => {
    // JSON.parse then JSON.stringify reorders keys and drops whitespace. The signature covers
    // bytes, so this is the number-one support question for every webhook product there is.
    const timestamp = now();
    const reserialised = JSON.stringify(JSON.parse(BODY.replace('{"type"', '{ "type"')));

    expect(
      webhooks.verify({
        payload: `{ "type":"email.delivered","data":{"id":"e_1"}}`,
        signature: sign(SECRET, timestamp, reserialised),
        timestamp,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it('rejects a non-numeric timestamp instead of throwing', () => {
    expect(webhooks.verify({payload: BODY, signature: 'v1=x', timestamp: 'not-a-time', secret: SECRET})).toBe(false);
  });

  it('rejects an empty signature header', () => {
    const timestamp = now();

    expect(webhooks.verify({payload: BODY, signature: '', timestamp, secret: SECRET})).toBe(false);
  });

  it('does not throw on a signature of the wrong length', () => {
    // `timingSafeEqual` throws on a length mismatch; comparing lengths first is what stops a
    // malformed header from becoming a 500 in somebody's webhook handler.
    const timestamp = now();

    expect(webhooks.verify({payload: BODY, signature: 'v1=short', timestamp, secret: SECRET})).toBe(false);
  });
});

describe('webhooks.assertValid', () => {
  it('throws on a bad signature', () => {
    expect(() => webhooks.assertValid({payload: BODY, signature: 'v1=nope', timestamp: now(), secret: SECRET})).toThrow(
      /verification failed/i,
    );
  });

  it('returns quietly on a good one', () => {
    const timestamp = now();

    expect(() =>
      webhooks.assertValid({payload: BODY, signature: sign(SECRET, timestamp, BODY), timestamp, secret: SECRET}),
    ).not.toThrow();
  });
});

/**
 * The cross-repository guard.
 *
 * Every test above signs with a helper that reimplements the scheme, so if the API changed it, the
 * helper and the client would be wrong together and all of them would still pass. This vector was
 * produced by the API's own `signPayload` (services/webhooks/signature.ts) and the API asserts the
 * same constant in its own suite. Change the scheme on either side and exactly one of the two
 * fails, in the repository where the change was made.
 */
describe('golden vector, generated by the API itself', () => {
  const SECRET_G = 'whsec_golden';
  const TIMESTAMP_G = 1767225600;
  const BODY_G = '{"type":"email.delivered","data":{"id":"e_1"}}';
  const SIGNATURE_G = 'ec12f37edc98cdd35c76d814284542bd88747ee90f9918a43de93f1bf757de44';

  it('verifies a signature the API produced', () => {
    expect(
      webhooks.verify({
        payload: BODY_G,
        signature: `v1=${SIGNATURE_G}`,
        timestamp: TIMESTAMP_G,
        secret: SECRET_G,
        // The vector is from a fixed instant in the past, so the replay bound has to be lifted for
        // this one assertion. Every other test above exercises the bound.
        toleranceSeconds: Infinity,
      }),
    ).toBe(true);
  });

  it('rejects the vector with one byte changed', () => {
    expect(
      webhooks.verify({
        payload: BODY_G,
        signature: `v1=${SIGNATURE_G.replace(/.$/, '5')}`,
        timestamp: TIMESTAMP_G,
        secret: SECRET_G,
        toleranceSeconds: Infinity,
      }),
    ).toBe(false);
  });
});
