import {describe, expect, it} from 'vitest';

import {redact} from '../../src/cli/redact.js';

/**
 * The filter every uploaded byte passes through.
 *
 * `init` reads a Stripe webhook handler and sends it to a model. A handler normally reads its
 * signing secret from `process.env` — *normally*. Plenty of git histories say otherwise, and the
 * cost of being wrong once is somebody's live key in a third party's logs, sent by a tool they ran
 * to save an afternoon.
 *
 * So this is deliberately over-tested, and the two halves matter equally. Missing a secret is the
 * obvious failure. Mangling a lockfile hash or a Tailwind class list into `<redacted>` is the
 * quieter one: it produces an extract the model cannot read, a worse analysis, and nobody can point
 * at the moment it went wrong.
 */

/**
 * Key-shaped fixtures are ASSEMBLED, never written as literals.
 *
 * The first version of this file spelled one out in full, and GitHub's push protection rejected the
 * whole branch. It was right to: a fixture written in Stripe's real key format is indistinguishable
 * from the thing it imitates, and a scanner should not be asked to tell them apart. Building the
 * string at runtime means no contiguous key-shaped literal exists in the source, while the filter
 * still sees exactly what it would see in somebody's repository.
 *
 * A file testing a secret filter is, unsurprisingly, the file most likely to trip a secret scanner.
 */
const key = (prefix: string, length = 32): string =>
  prefix + 'A1b2C3d4'.repeat(Math.ceil(length / 8)).slice(0, length);

describe('what it must catch', () => {
  it('a live Stripe key', () => {
    const live = key('sk_live_');
    const {text, count} = redact(`const stripe = new Stripe("${live}");`);

    expect(text).not.toContain(live.slice(8));
    expect(text).toContain('<redacted>');
    expect(count).toBe(1);
  });

  it('a test Stripe key too', () => {
    // Less damaging, still not ours to forward.
    expect(redact(key('sk_test_')).count).toBe(1);
  });

  it('a Stripe webhook signing secret', () => {
    const signing = key('whsec_');
    const {text} = redact(`const secret = "${signing}";`);

    expect(text).not.toContain(signing.slice(6));
  });

  it('our own secret keys', () => {
    // The tool must not leak the very key it just minted.
    expect(redact(`BITELIO_API_KEY=sk_test_${'a'.repeat(64)}`).count).toBe(1);
  });

  it('a bearer token in a header', () => {
    const {text} = redact(`headers: {authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(40)}.sig'}`);

    expect(text).toContain('<redacted>');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('a long hex run', () => {
    // What a hand-rolled token, an HMAC, or a database URL password tends to look like.
    expect(redact(`const token = '${'a1b2c3d4'.repeat(6)}';`).count).toBe(1);
  });

  it('a long base64 run', () => {
    expect(redact(`const key = 'aGVsbG9Xb3JsZFRoaXNJc0FTZWNyZXRLZXlWYWx1ZUhlcmVYWVo9PQ==';`).count).toBe(1);
  });

  it('a private key block, every line of it', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy',
      'vGZlGJpmn65+A4xHXInJYiPuKzrKUnApeLZ+vw1HocOAZtWK0z3r26uA8kQYOKX9',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const {text} = redact(pem);

    expect(text).not.toContain('MIIEpAIBAAKCAQEAy8Dbv8prpJ');
    expect(text).not.toContain('vGZlGJpmn65');
  });

  it('a password inside a connection string', () => {
    const {text} = redact('DATABASE_URL=postgresql://admin:hunter2isnotgreat@db.example.com:5432/app');

    expect(text).not.toContain('hunter2isnotgreat');
    // The shape stays readable — knowing it is Postgres is the useful part.
    expect(text).toContain('postgresql://');
  });

  it('an assignment to anything named like a secret, whatever the value looks like', () => {
    // The catch-all behind the shape rules. A four-character password matches no pattern at all.
    const {text} = redact("const apiSecret = 'abc1';\nconst PASSWORD = 'x9';");

    expect(text).not.toContain('abc1');
    expect(text).not.toContain('x9');
  });
});

describe('what it must NOT mangle', () => {
  it('a lockfile integrity hash', () => {
    // Long base64 by shape, and it says nothing. Redacting these turns a lockfile into noise.
    const line = '  integrity sha512-aGVsbG9Xb3JsZFRoaXNJc0FMb2NrZmlsZUhhc2hWYWx1ZUhlcmVYWVo9PQ==';

    expect(redact(line).count).toBe(0);
  });

  it('a git commit sha', () => {
    expect(redact('  "resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz#a1b2c3d4e5f6a7b8c9d0"').count).toBe(0);
  });

  it('a long Tailwind class list', () => {
    const line = 'className="flex min-h-screen flex-col items-center justify-between gap-4 rounded-lg border p-24"';

    expect(redact(line)).toEqual({text: line, count: 0});
  });

  it('a base64 data URI for an image', () => {
    const line = `<img src="data:image/png;base64,${'iVBORw0KGgo'.repeat(8)}" />`;

    expect(redact(line).count).toBe(0);
  });

  it('a reference to an environment variable, which is the correct pattern', () => {
    // This is what a well-written handler looks like. Redacting it would hide the good news.
    const line = 'const secret = process.env.STRIPE_WEBHOOK_SECRET;';

    expect(redact(line)).toEqual({text: line, count: 0});
  });

  it('a REAL value is not spared just because its last word reads like a placeholder', () => {
    // Found by running this over a real .env: stripping prefixes turned `prod-secret-key` into
    // `key`, which was on the placeholder list, and the filter waved it through. False negatives
    // are the expensive direction.
    expect(redact('AWS_SECRET_ACCESS_KEY=prod-secret-key').count).toBe(1);
    expect(redact('const dbPassword = "staging-db-value";').count).toBe(1);
  });

  it('a placeholder in an example file', () => {
    expect(redact(`STRIPE_SECRET_KEY=sk_live_${'x'.repeat(13)}`).count).toBe(0);
    expect(redact('STRIPE_SECRET_KEY=your-key-here').count).toBe(0);
  });

  it('the placeholder in our own documentation snippet', () => {
    // Found by running this over the dashboard: the greedy prefix strip ate `sk_YOUR_SECRET_` and
    // judged the leftover `KEY`, which is deliberately not on the placeholder list. Every strip
    // depth is tried now, so the `YOUR_…` is seen.
    expect(redact('curl -H "Authorization: Bearer sk_YOUR_SECRET_KEY"').count).toBe(0);
  });
});

describe('the count', () => {
  it('is what it says: one per redaction', () => {
    const {count} = redact(`sk_live_${'a'.repeat(24)}\nwhsec_${'b'.repeat(24)}\nsk_live_${'c'.repeat(24)}`);

    expect(count).toBe(3);
  });

  it('makes a file full of redactions visible as a warning', () => {
    // The reason the count is returned at all. Two redactions in a webhook handler is a developer
    // who inlined a secret; forty is a file that should not be uploaded, and the consent screen can
    // only say so if it is given the number.
    const committedSecrets = Array.from({length: 40}, (_, i) => `const key${i} = 'sk_live_${'a'.repeat(24)}${i}';`);

    expect(redact(committedSecrets.join('\n')).count).toBe(40);
  });

  it('is zero for an ordinary file, so the screen stays quiet', () => {
    const ordinary = "import {NextResponse} from 'next/server';\n\nexport async function POST() {\n  return NextResponse.json({ok: true});\n}";

    expect(redact(ordinary)).toEqual({text: ordinary, count: 0});
  });
});

describe('how it redacts', () => {
  it('keeps the line, so the code is still readable', () => {
    // The model has to be able to see that a secret is READ here, and where. Dropping the line
    // would hide the handler's shape along with the secret.
    const {text} = redact(`const stripe = new Stripe('sk_live_${'a'.repeat(24)}', {apiVersion: '2024-06-20'});`);

    expect(text).toContain('new Stripe(');
    expect(text).toContain('apiVersion');
  });

  it('keeps the prefix of a recognisable key, because the prefix is the useful part', () => {
    // "There is a LIVE Stripe key inlined here" is worth telling the model. The 24 characters after
    // it are not.
    expect(redact(`sk_live_${'a'.repeat(24)}`).text).toContain('sk_live_');
  });

  it('leaves line count and order untouched', () => {
    const input = `a\nsk_live_${'a'.repeat(24)}\nb`;

    expect(redact(input).text.split('\n')).toHaveLength(3);
    expect(redact(input).text.split('\n')[2]).toBe('b');
  });

  it('handles an empty file without complaining', () => {
    expect(redact('')).toEqual({text: '', count: 0});
  });
});
