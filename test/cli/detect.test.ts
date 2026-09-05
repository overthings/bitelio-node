import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {detect} from '../../src/cli/detect.js';

/**
 * Reading a repository well enough to know what `init` can and cannot do with it.
 *
 * Pattern matching only — no model runs here. That is what makes the consent screen honest: every
 * file it proposes to upload can be justified by a rule, and if a rule cannot justify a file the
 * screen is theatre.
 *
 * The assertion that keeps v1 honest is the last group. v1 understands one stack; pretending
 * otherwise produces the broken pull request nobody can test, and the version of this that guesses
 * is worse than the version that stops.
 */

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('an App Router repository with Clerk', () => {
  const repo = join(FIXTURES, 'app-router-clerk');

  it('knows it is Next, and which router', async () => {
    const found = await detect(repo);

    expect(found.supported).toBe(true);
    expect(found.framework).toEqual({name: 'next', version: '15.3.0', router: 'app'});
  });

  it('finds the Stripe handler by the call that makes it one', async () => {
    // Located by `stripe.webhooks.constructEvent`, not by the path. A handler is what verifies a
    // signature; where somebody filed it is a convention, and conventions vary.
    const found = await detect(repo);

    expect(found.stripe?.handler).toBe('app/api/webhooks/stripe/route.ts');
  });

  it('finds the signup handler by its Svix verification', async () => {
    const found = await detect(repo);

    expect(found.auth?.provider).toBe('clerk');
    expect(found.auth?.handler).toBe('app/api/webhooks/clerk/route.ts');
  });

  it('reads the user model out of the Prisma schema', async () => {
    // Events have to be typed against something. Guessing "User" is right often enough to be
    // dangerous and wrong often enough to matter.
    const found = await detect(repo);

    expect(found.dataModel).toEqual({kind: 'prisma', file: 'prisma/schema.prisma', userModel: 'User'});
  });

  it('reads the test command, because the patch has to be checked somehow', async () => {
    const found = await detect(repo);

    expect(found.testCommand).toBe('vitest run');
  });

  it('lists the file tree as paths only', async () => {
    const found = await detect(repo);

    expect(found.tree).toContain('app/api/webhooks/stripe/route.ts');
    expect(found.tree).toContain('lib/util.ts');
  });
});

describe('a Pages Router repository with Clerk', () => {
  const repo = join(FIXTURES, 'pages-router-clerk');

  it('knows the router is pages, which changes where every call goes', async () => {
    const found = await detect(repo);

    expect(found.framework?.router).toBe('pages');
  });

  it('finds both handlers under pages/api', async () => {
    const found = await detect(repo);

    expect(found.stripe?.handler).toBe('pages/api/webhooks/stripe.ts');
    expect(found.auth?.handler).toBe('pages/api/webhooks/clerk.ts');
  });

  it('reads a Drizzle schema, not only Prisma', async () => {
    const found = await detect(repo);

    expect(found.dataModel?.kind).toBe('drizzle');
    expect(found.dataModel?.userModel).toBe('members');
  });

  it('takes the test command as written, including its flags', async () => {
    expect((await detect(repo)).testCommand).toBe('jest --ci');
  });
});

describe('an App Router repository with no auth provider', () => {
  const repo = join(FIXTURES, 'app-router-no-auth');

  it('is still supported — Stripe alone is enough to be useful', async () => {
    const found = await detect(repo);

    expect(found.supported).toBe(true);
    expect(found.stripe?.handler).toBe('app/api/stripe/route.ts');
  });

  it('says plainly that there is no signup handler, rather than leaving it undefined', async () => {
    // The consent screen has to tell the developer which events cannot be detected. Silence reads
    // as "nothing to say", and the difference matters.
    const found = await detect(repo);

    expect(found.auth).toBeNull();
    expect(found.missing).toContain('auth');
  });
});

describe('a repository that is neither', () => {
  const repo = join(FIXTURES, 'not-supported');

  it('STOPS on an unknown stack rather than guessing', async () => {
    // The one that keeps v1 honest. Understanding one stack and admitting it beats understanding
    // none and producing a pull request nobody can test.
    const found = await detect(repo);

    expect(found.supported).toBe(false);
  });

  it('says what it looked for, so the answer is arguable', async () => {
    const found = await detect(repo);

    expect(found.reason).toMatch(/next/i);
    expect(found.reason).toMatch(/stripe/i);
  });

  it('proposes no files at all when it is not supported', async () => {
    // Nothing is uploaded from a repository it does not understand — not even the tree.
    const found = await detect(repo);

    expect(found.stripe).toBeNull();
    expect(found.tree).toEqual([]);
  });
});

describe('a monorepo, run from the root', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bitelio-mono-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'root', private: true, workspaces: ['apps/*']}));
    mkdirSync(join(dir, 'apps', 'web'), {recursive: true});
    writeFileSync(
      join(dir, 'apps', 'web', 'package.json'),
      JSON.stringify({dependencies: {next: '15.0.0', stripe: '17.0.0'}}),
    );
    mkdirSync(join(dir, 'apps', 'docs'), {recursive: true});
    writeFileSync(join(dir, 'apps', 'docs', 'package.json'), JSON.stringify({dependencies: {astro: '4.0.0'}}));
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('does not claim the project has neither, when a workspace has both', async () => {
    // Measured against a real Turborepo: the root answered "this project has neither", which is
    // false — the dependencies live in the workspaces. Telling somebody their Next + Stripe
    // monorepo is not a Next + Stripe project is worse than telling them nothing.
    const found = await detect(dir);

    expect(found.supported).toBe(false);
    expect(found.reason).not.toMatch(/has neither/);
  });

  it('names the workspace to run it from, rather than picking one', async () => {
    // Same principle as choosing a project: it can see the answer, and it is still not its choice.
    const found = await detect(dir);

    expect(found.reason).toContain('apps/web');
  });

  it('does not offer a workspace that would not be supported either', async () => {
    const found = await detect(dir);

    expect(found.reason).not.toContain('apps/docs');
  });

  it('says no workspace has both, rather than that the project has neither', async () => {
    // The shape of the Bitelio repo itself: one workspace is Next, another has Stripe, no single
    // one is both. "This project has neither" is the wrong sentence about that repository.
    rmSync(join(dir, 'apps', 'web'), {recursive: true, force: true});
    mkdirSync(join(dir, 'apps', 'front'), {recursive: true});
    writeFileSync(join(dir, 'apps', 'front', 'package.json'), JSON.stringify({dependencies: {next: '15.0.0'}}));
    mkdirSync(join(dir, 'apps', 'back'), {recursive: true});
    writeFileSync(join(dir, 'apps', 'back', 'package.json'), JSON.stringify({dependencies: {stripe: '17.0.0'}}));

    const found = await detect(dir);

    expect(found.reason).not.toMatch(/has neither/);
    expect(found.reason).toMatch(/workspace/i);
  });
});

describe('a Next app laid out under src/', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bitelio-src-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({dependencies: {next: '15.0.0', stripe: '17.0.0'}}));
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('finds the app router under src/app', async () => {
    // `src/app` and `src/pages` are a standard Next layout — `create-next-app` offers it — and the
    // real dashboard in this monorepo uses it. Looking only at the top level answered `router: null`
    // for a perfectly ordinary Next application.
    mkdirSync(join(dir, 'src', 'app'), {recursive: true});

    expect((await detect(dir)).framework?.router).toBe('app');
  });

  it('finds the pages router under src/pages', async () => {
    mkdirSync(join(dir, 'src', 'pages'), {recursive: true});

    expect((await detect(dir)).framework?.router).toBe('pages');
  });
});

describe('repositories that are broken in ordinary ways', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bitelio-detect-'));
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('refuses a directory with no package.json instead of crashing', async () => {
    const found = await detect(dir);

    expect(found.supported).toBe(false);
    expect(found.reason).toMatch(/package\.json/);
  });

  it('refuses a package.json that is not valid JSON, and says so', async () => {
    // A half-saved file, or a merge conflict. "Unexpected token }" is not an answer.
    writeFileSync(join(dir, 'package.json'), '{"name": "x",,}');

    const found = await detect(dir);

    expect(found.supported).toBe(false);
    expect(found.reason).toMatch(/package\.json/);
  });

  it('handles Next with neither app/ nor pages/ without inventing a router', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({dependencies: {next: '15.0.0', stripe: '17.0.0'}}));

    const found = await detect(dir);

    expect(found.framework?.router).toBeNull();
  });

  it('does not report a Stripe handler when the dependency is there but no handler is', async () => {
    // Installed and unused is a real state. Claiming a handler that is not there produces a patch
    // that edits a file which does not exist.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({dependencies: {next: '15.0.0', stripe: '17.0.0'}}));
    mkdirSync(join(dir, 'app'));

    const found = await detect(dir);

    expect(found.stripe).toBeNull();
    expect(found.missing).toContain('stripe-handler');
  });

  it('never walks into node_modules', async () => {
    // The one directory that would turn a three-level walk into a hundred thousand paths, and
    // would find a `constructEvent` inside the Stripe package itself.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({dependencies: {next: '15.0.0', stripe: '17.0.0'}}));
    mkdirSync(join(dir, 'app'));
    mkdirSync(join(dir, 'node_modules', 'stripe'), {recursive: true});
    writeFileSync(join(dir, 'node_modules', 'stripe', 'index.js'), 'stripe.webhooks.constructEvent(a, b, c)');

    const found = await detect(dir);

    expect(found.stripe).toBeNull();
    expect(found.tree.some(path => path.includes('node_modules'))).toBe(false);
  });

  it('reports no test command rather than inventing one', async () => {
    // `init` verifies its patch by running the tests. Making one up runs something arbitrary in
    // somebody's repository.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({dependencies: {next: '15.0.0', stripe: '17.0.0'}}));

    expect((await detect(dir)).testCommand).toBeNull();
  });
});
