import {PassThrough} from 'node:stream';
import {beforeEach, describe, expect, it} from 'vitest';

import {askConsent, printDryRun} from '../../src/cli/consent.js';
import type {Extract, ExtractFile} from '../../src/cli/extract.js';

/**
 * The screen that makes the upload the developer's decision.
 *
 * The assertions that earn their place are the ones about what it refuses to hide: a preview that
 * differs from what is sent, an exclusion presented as costing nothing, a truncation nobody is told
 * about, and — the one that decides whether any of this is real — uploading without a yes.
 */

let printed = '';

function tty(typed: string[]) {
  const input = new PassThrough() as PassThrough & {isTTY?: boolean};
  const output = new PassThrough() as PassThrough & {isTTY?: boolean};
  input.isTTY = true;
  output.isTTY = true;

  const queued = [...typed];
  const answer = () => {
    const next = queued.shift();
    if (next !== undefined) setTimeout(() => input.write(`${next}\n`), 4);
  };
  output.on('data', (chunk: Buffer) => {
    printed += chunk.toString();
    answer();
  });
  setTimeout(answer, 4);

  return {input, output};
}

function pipe() {
  const output = new PassThrough() as PassThrough & {isTTY?: boolean};
  output.on('data', (chunk: Buffer) => {
    printed += chunk.toString();
  });

  return {input: new PassThrough(), output};
}

const file = (over: Partial<ExtractFile> = {}): ExtractFile => ({
  path: 'package.json',
  content: '{"name":"x"}',
  why: 'dependencies and the test command',
  redactions: 0,
  truncated: false,
  ...over,
});

function extract(over: Partial<Extract> = {}): Extract {
  return {
    supported: true,
    reason: null,
    detected: {
      supported: true,
      reason: null,
      framework: {name: 'next', version: '15.0.0', router: 'app'},
      stripe: {handler: 'app/api/webhooks/stripe/route.ts'},
      auth: null,
      dataModel: null,
      testCommand: 'vitest',
      missing: [],
      tree: [],
      treeTruncatedBy: 0,
    },
    files: [file(), file({path: 'app/api/webhooks/stripe/route.ts', content: 'x'.repeat(500), why: 'your Stripe webhook'})],
    dropped: [],
    totalBytes: 512,
    ...over,
  };
}

beforeEach(() => {
  printed = '';
});

describe('the listing', () => {
  it('names every file and why it is there', async () => {
    await askConsent(extract(), tty(['u']));

    expect(printed).toContain('package.json');
    expect(printed).toContain('dependencies and the test command');
  });

  it('says how many secrets were redacted, when there were any', async () => {
    await askConsent(extract({files: [file({redactions: 3})]}), tty(['u']));

    expect(printed).toMatch(/3 secrets redacted/);
  });

  it('stays quiet about redactions when there were none', async () => {
    await askConsent(extract(), tty(['u']));

    expect(printed).not.toMatch(/redacted/);
  });

  it('SAYS WHAT WAS DROPPED for size, rather than implying the extract is complete', async () => {
    await askConsent(extract({dropped: ['(file tree)']}), tty(['u']));

    expect(printed).toMatch(/left out.*file tree/i);
  });

  it('SAYS WHAT IT DID NOT FIND, not only what it did', async () => {
    // Found by pointing this at a real Next app with no webhook handler: the listing offered two
    // files and said nothing at all about the three events that were now out of reach. A listing
    // that only reports what it found reads as though it found everything.
    const missing = extract();
    missing.detected.missing = ['stripe-handler', 'auth', 'test-command'];

    await askConsent(missing, tty(['u']));

    expect(printed).toMatch(/no stripe webhook handler found/i);
    expect(printed).toContain('subscription_started');
    expect(printed).toMatch(/no signup webhook/i);
    expect(printed).toMatch(/no `test` script/i);
  });

  it('says nothing about what is missing when nothing is', async () => {
    await askConsent(extract(), tty(['u']));

    expect(printed).not.toMatch(/cannot be detected/i);
  });

  it('says when a file was truncated', async () => {
    await askConsent(extract({files: [file({truncated: true})]}), tty(['u']));

    expect(printed).toMatch(/truncated/i);
  });
});

describe('viewing a file', () => {
  it('shows exactly the bytes that would be sent', async () => {
    // The property that makes the screen worth having. A preview of the original while the redacted
    // copy goes on the wire — or the reverse — is worse than showing nothing.
    const redacted = 'const key = <redacted>;';

    await askConsent(extract({files: [file({content: redacted})]}), tty(['v', '1', 'u']));

    expect(printed).toContain(redacted);
  });
});

describe('excluding a file', () => {
  it('SAYS WHICH EVENTS ARE LOST, rather than letting it read as free', async () => {
    const chosen = await askConsent(extract(), tty(['x', '2', 'u']));

    expect(printed).toMatch(/cannot be detected/i);
    expect(printed).toContain('subscription_started');
    expect(chosen.files.map(f => f.path)).toEqual(['package.json']);
  });

  it('can be undone without starting over', async () => {
    const chosen = await askConsent(extract(), tty(['x', '2', 'x', '2', 'u']));

    expect(chosen.files).toHaveLength(2);
  });
});

describe('the decision', () => {
  it('uploads only what was approved', async () => {
    const chosen = await askConsent(extract(), tty(['u']));

    expect(chosen.approved).toBe(true);
    expect(chosen.files).toHaveLength(2);
  });

  it('quitting sends nothing', async () => {
    const chosen = await askConsent(extract(), tty(['q']));

    expect(chosen.approved).toBe(false);
    expect(chosen.files).toEqual([]);
  });

  it('REFUSES to proceed when nobody is there to say yes', async () => {
    // The one that decides whether any of this is real. Printing a listing into a CI log and
    // uploading anyway would make the whole screen decoration.
    await expect(askConsent(extract(), pipe())).rejects.toThrow(/terminal|dry-run/i);
  });
});

describe('--dry-run', () => {
  it('prints the same rows the consent screen would, and uploads nothing', () => {
    printDryRun(extract({dropped: ['(file tree)']}), pipe());

    expect(printed).toContain('package.json');
    expect(printed).toMatch(/would leave out/i);
    expect(printed).toMatch(/nothing was uploaded/i);
  });

  it('works with no terminal, which is the point of it', () => {
    expect(() => printDryRun(extract(), pipe())).not.toThrow();
  });
});
