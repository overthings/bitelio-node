import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import type {Verdict} from '../../src/cli/apply.js';
import {buildBody} from '../../src/cli/pullRequest.js';

/**
 * What the pull request says.
 *
 * A pull request is frequently public, and it is read by somebody deciding whether to merge. So the
 * assertions worth having are about what it must not contain, and what it must not let a reviewer
 * assume: that a check ran when none did, that a guess was a finding, or that a test key sends mail.
 */

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  safe: true,
  checks: [{name: 'npm test', before: true, after: true, output: ''}],
  ranNothing: false,
  branch: 'bitelio-init',
  ...over,
});

const input = (over: Partial<Parameters<typeof buildBody>[0]> = {}) => ({
  verdict: verdict(),
  created: [{path: 'lib/bitelio.ts', contents: '', reviewed: false}],
  replaced: [{path: 'app/api/webhooks/stripe/route.ts', contents: '', reviewed: true}],
  unsure: [],
  dashboardUrl: 'https://app.bitelio.com/settings',
  ...over,
});

describe('what it must never contain', () => {
  it('PUTS NO CREDENTIAL IN THE BODY — only the variable name', () => {
    const body = buildBody(input());

    expect(body).toContain('BITELIO_API_KEY=');
    expect(body).not.toMatch(/sk_(live|test)_[A-Za-z0-9]{16,}/);
  });

  it('refuses outright if a key somehow reaches it', () => {
    // The last gate. The server already refuses a patch containing one and the redaction pass runs
    // on the way in, but this is the text that becomes public.
    const withKey = input({dashboardUrl: `https://app.bitelio.com/?k=sk_live_${'a'.repeat(24)}`});

    expect(() => buildBody(withKey)).toThrow(/key/i);
  });

  it('says that a test key delivers nothing', () => {
    // The failure this exists to prevent: a test key in production configuration is an app that
    // deploys, runs, records everything and delivers none of it — silently.
    const body = buildBody(input());

    expect(body).toMatch(/test key sends nothing/i);
    expect(body).toMatch(/not what you want in production/i);
  });
});

describe('what it says about the checks', () => {
  it('states which ran, and their result', () => {
    expect(buildBody(input())).toMatch(/`npm test` — passed before and after/);
  });

  it('says LOUDLY when none ran', () => {
    // Silence reads as "checked, and fine". The difference decides whether a reviewer skims this or
    // reads it.
    const body = buildBody(input({verdict: verdict({checks: [], ranNothing: true})}));

    expect(body).toMatch(/\*\*Nothing was run\.\*\*/);
    expect(body).toMatch(/unverified/i);
    expect(body).toMatch(/draft/i);
  });

  it('says a pre-existing failure was NOT caused by this change', () => {
    // Otherwise somebody spends an afternoon looking for what `init` broke on a branch that broke
    // nothing.
    const already = verdict({checks: [{name: 'npm test', before: false, after: false, output: 'boom'}]});

    expect(buildBody(input({verdict: already}))).toMatch(/already failing.*Not caused by this change/is);
  });
});

describe('what it says about the files', () => {
  it('marks new files as new, because nobody reviewed them beforehand', () => {
    // Replacements were on the consent screen. Creations were not, by definition.
    const body = buildBody(input());

    expect(body).toMatch(/`lib\/bitelio\.ts` — \*\*new file\*\*/);
    expect(body).toMatch(/`app\/api\/webhooks\/stripe\/route\.ts` — edited/);
  });
});

describe('what the model was unsure of', () => {
  it('lists it, so a guess does not read as a finding', () => {
    const body = buildBody(input({unsure: [{name: 'trial_ending', source: 'app/api/cron/route.ts'}]}));

    expect(body).toMatch(/second look/i);
    expect(body).toContain('trial_ending');
    expect(body).toContain('app/api/cron/route.ts');
  });

  it('says nothing at all when there was nothing uncertain', () => {
    expect(buildBody(input())).not.toMatch(/second look/i);
  });
});

describe('opening it', () => {
  /** Nothing here touches the network: `gh` and `git` are both injected. */
  function deps(over: Partial<import('../../src/cli/pullRequest.js').PullRequestDeps> = {}) {
    return {
      ghUsable: async () => true,
      exec: async () => ({stdout: 'https://github.com/acme/shop/pull/7\n'}),
      ...over,
    };
  }

  function repoWithRemote(remote?: string) {
    const repo = mkdtempSync(join(tmpdir(), 'bitelio-pr-'));
    execFileSync('git', ['init', '-q'], {cwd: repo});
    if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], {cwd: repo});

    return repo;
  }

  it('returns the URL it opened', async () => {
    const {openPullRequest} = await import('../../src/cli/pullRequest.js');
    const repo = repoWithRemote('git@github.com:acme/shop.git');

    const result = await openPullRequest(repo, 'bitelio-init', 'main', 'body', deps());

    expect(result.url).toBe('https://github.com/acme/shop/pull/7');
    expect(result.reason).toBeNull();
    rmSync(repo, {recursive: true, force: true});
  });

  it('passes the body as an ARGUMENT, never through a shell', async () => {
    // The body is model-derived text full of backticks and newlines. Interpolating it into a shell
    // string is how a pull request body becomes a command.
    const {openPullRequest} = await import('../../src/cli/pullRequest.js');
    const repo = repoWithRemote('git@github.com:acme/shop.git');
    const calls: {file: string; args: string[]}[] = [];

    await openPullRequest(repo, 'bitelio-init', 'main', '`whoami`; rm -rf /', {
      ...deps(),
      exec: async (file: string, args: string[]) => {
        calls.push({file, args});

        return {stdout: 'https://github.com/acme/shop/pull/7'};
      },
    });

    const create = calls.find(call => call.file === 'gh')!;
    expect(create.args).toContain('`whoami`; rm -rf /');
    expect(calls.every(call => call.file !== 'sh' && call.file !== 'bash')).toBe(true);
    rmSync(repo, {recursive: true, force: true});
  });
});

describe('when the pull request cannot be opened', () => {
  it('keeps the branch and says where to open it by hand when gh is missing', async () => {
    // The branch is the valuable part and it is already committed. A tool that throws away working
    // work because an optional last step failed is a tool nobody runs twice.
    const {openPullRequest} = await import('../../src/cli/pullRequest.js');
    const repo = mkdtempSync(join(tmpdir(), 'bitelio-pr-'));
    execFileSync('git', ['init', '-q'], {cwd: repo});
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/shop.git'], {cwd: repo});

    const result = await openPullRequest(repo, 'bitelio-init', 'main', 'body', {
      ghUsable: async () => false,
      exec: async () => {
        throw new Error('must not be reached');
      },
    });

    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/not installed or not signed in/i);
    expect(result.openManuallyAt).toBe('https://github.com/acme/shop/compare/bitelio-init?expand=1');

    rmSync(repo, {recursive: true, force: true});
  });

  it('keeps the branch when the push itself is refused, and says why', async () => {
    // Protected branch, no permission, no upstream — all different problems with different fixes,
    // and a generic sentence helps with none of them.
    const {openPullRequest} = await import('../../src/cli/pullRequest.js');
    const repo = mkdtempSync(join(tmpdir(), 'bitelio-pr-'));
    execFileSync('git', ['init', '-q'], {cwd: repo});
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/shop.git'], {cwd: repo});

    const result = await openPullRequest(repo, 'bitelio-init', 'main', 'body', {
      ghUsable: async () => true,
      exec: async () => {
        throw new Error('remote: Permission to acme/shop.git denied');
      },
    });

    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/Permission to acme\/shop\.git denied/);
    expect(result.openManuallyAt).toContain('/compare/');

    rmSync(repo, {recursive: true, force: true});
  });

  it('says so plainly when there is no GitHub remote to point at either', async () => {
    const {openPullRequest} = await import('../../src/cli/pullRequest.js');
    const repo = mkdtempSync(join(tmpdir(), 'bitelio-pr-'));
    execFileSync('git', ['init', '-q'], {cwd: repo});

    const result = await openPullRequest(repo, 'bitelio-init', 'main', 'body', {
      ghUsable: async () => false,
      exec: async () => ({stdout: ''}),
    });

    expect(result.openManuallyAt).toBeNull();
    expect(result.reason).toBeTruthy();

    rmSync(repo, {recursive: true, force: true});
  });
});
