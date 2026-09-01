import {describe, expect, it, vi} from 'vitest';

import {Bitelio, BitelioError} from '../src/index.js';

/** A fetch that answers a scripted sequence and records what it was asked. */
function scriptedFetch(responses: (Response | Error)[]) {
  const calls: {url: string; init: RequestInit}[] = [];
  const fetchImpl = vi.fn(async (url: URL | string, init: RequestInit) => {
    calls.push({url: String(url), init});
    const next = responses.shift();
    if (next === undefined) throw new Error('fetch called more times than the script allows');
    if (next instanceof Error) throw next;
    return next;
  });

  return {fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, calls};
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});

// A FUNCTION, not a constant. A Response body can only be read once, so a shared instance makes
// the second test that touches it fail with "Body is unusable" — a harness bug that reads exactly
// like a client bug.
const sendOk = () => json(200, {success: true, data: {emails: [], timestamp: '2026-09-01T00:00:00.000Z'}});

const client = (fetchImpl: typeof globalThis.fetch, maxRetries = 2) =>
  new Bitelio('sk_test_x', {fetch: fetchImpl, maxRetries});

const params = {to: 'a@b.test', subject: 's', body: '<p>b</p>', from: 'x@y.test'};

describe('idempotency', () => {
  it('generates a key for every send, without being asked', async () => {
    // This client retries. A retried send with no key is a duplicate in somebody's inbox, so the
    // key is not an option a caller can forget.
    const {fetchImpl, calls} = scriptedFetch([sendOk()]);

    await client(fetchImpl).emails.send(params);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses the SAME key across retries — the whole reason it exists', async () => {
    const {fetchImpl, calls} = scriptedFetch([json(503, {}), sendOk()]);

    await client(fetchImpl).emails.send(params);

    expect(calls).toHaveLength(2);
    const [first, second] = calls.map(c => (c.init.headers as Record<string, string>)['idempotency-key']);
    expect(first).toBe(second);
  });

  it('honours a key the caller supplied', async () => {
    const {fetchImpl, calls} = scriptedFetch([sendOk()]);

    await client(fetchImpl).emails.send({...params, idempotencyKey: 'order-42'});

    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('order-42');
  });

  it('does not put the key in the body', async () => {
    const {fetchImpl, calls} = scriptedFetch([sendOk()]);

    await client(fetchImpl).emails.send({...params, idempotencyKey: 'order-42'});

    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty('idempotencyKey');
  });

  it('gives a different key to each call', async () => {
    const {fetchImpl, calls} = scriptedFetch([sendOk(), sendOk()]);
    const bitelio = client(fetchImpl);

    await bitelio.emails.send(params);
    await bitelio.emails.send(params);

    const keys = calls.map(c => (c.init.headers as Record<string, string>)['idempotency-key']);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('retries', () => {
  it('retries a 5xx and returns the eventual success', async () => {
    const {fetchImpl, calls} = scriptedFetch([json(500, {}), json(500, {}), sendOk()]);

    await expect(client(fetchImpl).emails.send(params)).resolves.toBeTruthy();
    expect(calls).toHaveLength(3);
  });

  it('retries a 429', async () => {
    const {fetchImpl, calls} = scriptedFetch([json(429, {}, {'retry-after': '0'}), sendOk()]);

    await client(fetchImpl).emails.send(params);

    expect(calls).toHaveLength(2);
  });

  it('NEVER retries a 4xx — a 403 retried is a 403 three times slower', async () => {
    const {fetchImpl, calls} = scriptedFetch([json(403, {error: {message: 'Nope', code: 'DENIED'}})]);

    await expect(client(fetchImpl).emails.send(params)).rejects.toThrow(/Nope/);
    expect(calls).toHaveLength(1);
  });

  it('retries a transport failure, which never reached the API at all', async () => {
    const {fetchImpl, calls} = scriptedFetch([new TypeError('fetch failed'), sendOk()]);

    await client(fetchImpl).emails.send(params);

    expect(calls).toHaveLength(2);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const {fetchImpl, calls} = scriptedFetch([json(500, {}), json(500, {}), json(500, {})]);

    await expect(client(fetchImpl).emails.send(params)).rejects.toMatchObject({status: 500});
    expect(calls).toHaveLength(3);
  });

  it('can be turned off', async () => {
    const {fetchImpl, calls} = scriptedFetch([json(500, {})]);

    await expect(client(fetchImpl, 0).emails.send(params)).rejects.toBeInstanceOf(BitelioError);
    expect(calls).toHaveLength(1);
  });
});

describe('errors', () => {
  it('carries the request id, which is what makes a 500 answerable', async () => {
    const {fetchImpl} = scriptedFetch([json(500, {error: {message: 'boom'}}, {'x-request-id': 'req-9'})]);

    await expect(client(fetchImpl, 0).emails.send(params)).rejects.toMatchObject({requestId: 'req-9'});
  });

  it('prefers the header over the body, so a proxy 502 still identifies itself', async () => {
    const {fetchImpl} = scriptedFetch([
      json(502, {error: {message: 'bad gateway', requestId: 'stale'}}, {'x-request-id': 'req-real'}),
    ]);

    await expect(client(fetchImpl, 0).emails.send(params)).rejects.toMatchObject({requestId: 'req-real'});
  });

  it('survives an error response that is not JSON', async () => {
    // A load balancer's HTML error page must not turn into a parse crash inside the SDK.
    const {fetchImpl} = scriptedFetch([new Response('<html>504</html>', {status: 504})]);

    await expect(client(fetchImpl, 0).emails.send(params)).rejects.toMatchObject({status: 504});
  });

  it('refuses to be constructed without a key, rather than 401ing later', async () => {
    expect(() => new Bitelio('')).toThrow(/API key is required/);
  });
});

describe('emails.list', () => {
  it('serialises Date filters as ISO 8601', async () => {
    const {fetchImpl, calls} = scriptedFetch([json(200, {data: [], nextCursor: null})]);

    await client(fetchImpl).emails.list({since: new Date('2026-01-01T00:00:00.000Z'), status: 'BOUNCED'});

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('since')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('status')).toBe('BOUNCED');
  });

  it('omits absent filters instead of sending "undefined"', async () => {
    const {fetchImpl, calls} = scriptedFetch([json(200, {data: [], nextCursor: null})]);

    await client(fetchImpl).emails.list({limit: 10});

    expect(new URL(calls[0]!.url).searchParams.has('status')).toBe(false);
  });

  it('iterate() walks every page and stops at a null cursor', async () => {
    const {fetchImpl, calls} = scriptedFetch([
      json(200, {data: [{id: 'a'}, {id: 'b'}], nextCursor: 'b'}),
      json(200, {data: [{id: 'c'}], nextCursor: null}),
    ]);

    const seen: string[] = [];
    for await (const email of client(fetchImpl).emails.iterate({limit: 2})) seen.push(email.id);

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('b');
  });
});
