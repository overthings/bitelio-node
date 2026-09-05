import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {build, EXTRACT_CAP_BYTES, readForUpload, undetectableWithout} from '../../src/cli/extract.js';

/**
 * Assembling what gets uploaded.
 *
 * Two properties carry this file, and both are about the developer being able to answer for what
 * left their machine. Nothing is included that a rule cannot justify — that is what stops the
 * consent screen being theatre. And nothing is dropped silently: a truncated extract produces a
 * worse analysis that nobody can account for afterwards.
 */

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

/**
 * Key-shaped fixtures are ASSEMBLED, never written as literals — see the note in `redact.test.ts`.
 * GitHub's push protection rejects a branch containing one, and it is right to: a fixture in a
 * provider's real key format is indistinguishable from the thing it imitates.
 */
const key = (prefix: string, length = 32): string =>
  prefix + 'A1b2C3d4'.repeat(Math.ceil(length / 8)).slice(0, length);

describe('what it assembles', () => {
  it('includes the manifest, both handlers, the schema and the tree', async () => {
    const extract = await build(join(FIXTURES, 'app-router-clerk'));

    expect(extract.files.map(file => file.path)).toEqual([
      'package.json',
      'app/api/webhooks/stripe/route.ts',
      'app/api/webhooks/clerk/route.ts',
      'prisma/schema.prisma',
      '(file tree)',
    ]);
  });

  it('gives every file a reason, in words a person can check', async () => {
    // The consent screen shows these. "Because a model wanted it" is not a reason anyone can argue
    // with, so no file is here for that.
    const extract = await build(join(FIXTURES, 'app-router-clerk'));

    for (const file of extract.files) {
      expect(file.why, file.path).toBeTruthy();
    }
    expect(extract.files.find(f => f.path === 'package.json')?.why).toMatch(/dep|test/i);
  });

  it('sends the redacted text, not the original', async () => {
    // The property that matters most: what the screen shows and what the wire carries are the same
    // bytes. A screen that previews one thing and uploads another is worse than no screen.
    const extract = await build(join(FIXTURES, 'app-router-clerk'));
    const handler = extract.files.find(f => f.path.includes('stripe'))!;

    expect(handler.content).toContain('process.env.STRIPE_WEBHOOK_SECRET');
    expect(typeof handler.redactions).toBe('number');
  });
});

describe('what it will not touch', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bitelio-extract-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({dependencies: {next: '15.0.0', stripe: '17.0.0'}}));
    mkdirSync(join(dir, 'app'), {recursive: true});
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('REFUSES to read a .env file, whatever it is called', async () => {
    // Driven through `readForUpload` directly, and that is the point. Asserting this through
    // `build` passed with the guard deleted, because nothing in the current plan ever asks for a
    // `.env` — the test proved a property of the planner, not of the guard. The guard is the only
    // thing standing between a future planner and somebody's credentials.
    for (const name of ['.env', '.env.local', '.env.production', '.env.development.local', '.env.example']) {
      writeFileSync(join(dir, name), `STRIPE_SECRET_KEY=${key('sk_live_')}`);

      expect(await readForUpload(dir, name), name).toBeNull();
    }
  });

  it('reads an ordinary file, so the refusal above is about .env and not about everything', async () => {
    writeFileSync(join(dir, 'ordinary.ts'), 'export const x = 1;');

    expect(await readForUpload(dir, 'ordinary.ts')).toEqual({content: 'export const x = 1;', redactions: 0});
  });

  it('puts no .env in the tree, not even .env.example', async () => {
    // `.env.example` is the one the directory walk deliberately lets through — its variable NAMES
    // are useful documentation. It still does not travel: people paste real keys into these, and
    // the names are already visible in the handler that reads them.
    const committed = key('sk_live_');
    writeFileSync(join(dir, '.env.example'), `STRIPE_SECRET_KEY=${committed}`);

    const extract = await build(dir);
    const tree = extract.files.find(f => f.path === '(file tree)')!;

    expect(tree.content).not.toContain('.env');
    expect(JSON.stringify(extract)).not.toContain(committed.slice(8));
  });

  it('passes every file through the secret filter, and counts what it found', async () => {
    // Also driven by a file that actually contains one. With a clean fixture, deleting the redact
    // call changed nothing and the test still passed.
    mkdirSync(join(dir, 'app', 'api'), {recursive: true});
    writeFileSync(
      join(dir, 'app', 'api', 'route.ts'),
      `const stripe = new Stripe('sk_live_${'a'.repeat(24)}');\nstripe.webhooks.constructEvent(a, b, c);\n`,
    );

    const extract = await build(dir);
    const handler = extract.files.find(f => f.path.endsWith('route.ts'))!;

    expect(handler.content).not.toContain('a'.repeat(24));
    expect(handler.redactions).toBe(1);
  });
});

describe('the 100 KB cap', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bitelio-cap-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({scripts: {test: 'vitest'}, dependencies: {next: '15.0.0', stripe: '17.0.0'}}),
    );
    mkdirSync(join(dir, 'app', 'api'), {recursive: true});
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  /** A handler big enough to blow the cap on its own. */
  function hugeHandler() {
    const filler = '// padding to make this file large\n'.repeat(4000);
    writeFileSync(
      join(dir, 'app', 'api', 'route.ts'),
      `${filler}const event = stripe.webhooks.constructEvent(a, b, c);\n`,
    );
  }

  it('DROPS BY PRIORITY and says what it dropped', async () => {
    // Tree first, schema next — the handler is the thing being analysed and goes last. Silence here
    // would mean an analysis missing half its input that reads as complete.
    hugeHandler();
    mkdirSync(join(dir, 'prisma'));
    writeFileSync(join(dir, 'prisma', 'schema.prisma'), 'model User {\n  email String\n}\n');

    const extract = await build(dir);

    expect(extract.totalBytes).toBeLessThanOrEqual(EXTRACT_CAP_BYTES);
    expect(extract.dropped.length).toBeGreaterThan(0);
    expect(extract.dropped[0]).toBe('(file tree)');
  });

  it('keeps the Stripe handler even when it is the thing that is too big', async () => {
    // Dropping the handler leaves an extract that cannot answer the question it was assembled for.
    // It is truncated instead, and the truncation is stated.
    hugeHandler();

    const extract = await build(dir);
    const handler = extract.files.find(f => f.path.endsWith('route.ts'));

    expect(handler).toBeTruthy();
    expect(handler!.truncated).toBe(true);
  });

  it('says nothing about dropping when nothing was dropped', async () => {
    writeFileSync(join(dir, 'app', 'api', 'route.ts'), 'stripe.webhooks.constructEvent(a, b, c);');

    const extract = await build(dir);

    expect(extract.dropped).toEqual([]);
    expect(extract.files.every(f => !f.truncated)).toBe(true);
  });
});

describe('what excluding a file costs', () => {
  it('says which events can no longer be detected without the Stripe handler', async () => {
    // Excluding it must not read as "makes no difference". These three are exactly what that file
    // is read for.
    const lost = undetectableWithout('app/api/webhooks/stripe/route.ts', {
      stripe: {handler: 'app/api/webhooks/stripe/route.ts'},
      auth: {provider: 'clerk', handler: 'app/api/webhooks/clerk/route.ts'},
    });

    expect(lost).toEqual(['subscription_started', 'payment_failed', 'cancelled']);
  });

  it('says which are lost without the signup handler', () => {
    const lost = undetectableWithout('app/api/webhooks/clerk/route.ts', {
      stripe: {handler: 'app/api/webhooks/stripe/route.ts'},
      auth: {provider: 'clerk', handler: 'app/api/webhooks/clerk/route.ts'},
    });

    expect(lost).toEqual(['signup', 'email_verification']);
  });

  it('is empty for a file whose absence costs no events', () => {
    const lost = undetectableWithout('package.json', {
      stripe: {handler: 'app/api/webhooks/stripe/route.ts'},
      auth: null,
    });

    expect(lost).toEqual([]);
  });
});
