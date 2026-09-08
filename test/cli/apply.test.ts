import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {applyPatch, currentBranch, initialiseRepository, isClean, isGitRepository, verifyPatch} from '../../src/cli/apply.js';
import type {Patch} from '../../src/cli/apply.js';

/**
 * Writing to somebody else's repository.
 *
 * This is the only part of `init` that touches a working tree, so every refusal here is load
 * bearing. The two that matter most: it will not run over uncommitted work, and it will not write a
 * file the developer never saw — the same allowlist the server enforces, checked again on this side
 * because the server's copy protects the server and this one protects the disk.
 */

let parent: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
}

beforeEach(() => {
  // The repository lives INSIDE its own temp parent, so `..` from it is unique to this test. With
  // the repo as the temp directory itself, `../escaped.ts` resolved to `/tmp/escaped.ts` — shared
  // by every test and every run — and one escape left behind made the containment test fail
  // afterwards for a reason that had nothing to do with the code under test.
  parent = mkdtempSync(join(tmpdir(), 'bitelio-apply-'));
  repo = join(parent, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  mkdirSync(join(repo, 'app'), {recursive: true});
  writeFileSync(join(repo, 'app', 'handler.ts'), 'export const handler = 1;\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'fixture'}, null, 2));
  git('add', '-A');
  git('commit', '-qm', 'initial');
});

afterEach(() => {
  rmSync(parent, {recursive: true, force: true});
});

const patch = (over: Partial<Patch> = {}): Patch => ({
  replace: [{path: 'app/handler.ts', contents: 'export const handler = 2;\n', reviewed: true}],
  create: [{path: 'lib/bitelio.ts', contents: 'export const client = 1;\n', reviewed: false}],
  ...over,
});

describe('before it writes anything', () => {
  it('REFUSES to run with uncommitted changes', async () => {
    // An `init` that entangles itself with work in progress is an `init` people run once. It also
    // makes the branch it creates impossible to throw away cleanly.
    writeFileSync(join(repo, 'app', 'handler.ts'), 'half-finished\n');

    await expect(applyPatch(repo, patch(), {branch: 'bitelio-init'})).rejects.toThrow(/uncommitted/i);
  });

  it('refuses on an untracked file too, not only a modified one', async () => {
    // `git status --porcelain` reports both. A tool that only checks for modifications will happily
    // commit somebody's scratch file into the branch it just made.
    writeFileSync(join(repo, 'notes.md'), 'scratch\n');

    await expect(applyPatch(repo, patch(), {branch: 'bitelio-init'})).rejects.toThrow(/uncommitted/i);
  });

  it('refuses outside a git repository, rather than writing files loose', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'bitelio-nogit-'));

    await expect(applyPatch(bare, patch(), {branch: 'bitelio-init'})).rejects.toThrow(/git/i);

    rmSync(bare, {recursive: true, force: true});
  });

  it('REFUSES a replacement for a file that is not in the repository', async () => {
    // The client-side half of the allowlist. The server has its own copy; this one protects the
    // disk, and it is the one that runs even if somebody points the CLI at a different server.
    const bad = patch({replace: [{path: 'app/nothing-here.ts', contents: 'x', reviewed: true}]});

    await expect(applyPatch(repo, bad, {branch: 'bitelio-init'})).rejects.toThrow(/nothing-here/);
  });

  it('refuses a path that climbs out of the repository', async () => {
    const bad = patch({create: [{path: '../escaped.ts', contents: 'x', reviewed: false}], replace: []});

    await expect(applyPatch(repo, bad, {branch: 'bitelio-init'})).rejects.toThrow();
    expect(existsSync(join(parent, 'escaped.ts'))).toBe(false);
  });
});

describe('what it does to the repository', () => {
  it('branches from HEAD and leaves the original branch exactly as it was', async () => {
    const before = git('rev-parse', 'main');

    await applyPatch(repo, patch(), {branch: 'bitelio-init'});

    expect(git('rev-parse', 'main')).toBe(before);
    expect(currentBranch(repo)).toBe('bitelio-init');
  });

  it('leaves the working tree clean, so nothing is half-applied', async () => {
    await applyPatch(repo, patch(), {branch: 'bitelio-init'});

    expect(isClean(repo)).toBe(true);
  });

  it('writes both the replacement and the creation', async () => {
    await applyPatch(repo, patch(), {branch: 'bitelio-init'});

    expect(readFileSync(join(repo, 'app', 'handler.ts'), 'utf8')).toContain('handler = 2');
    expect(readFileSync(join(repo, 'lib', 'bitelio.ts'), 'utf8')).toContain('client = 1');
  });

  it('creates the directories a new file needs', async () => {
    const deep = patch({create: [{path: 'src/lib/deep/client.ts', contents: 'x\n', reviewed: false}], replace: []});

    await applyPatch(repo, deep, {branch: 'bitelio-init'});

    expect(readFileSync(join(repo, 'src', 'lib', 'deep', 'client.ts'), 'utf8')).toBe('x\n');
  });

  it('puts everything in ONE commit, so it can be undone with one command', async () => {
    await applyPatch(repo, patch(), {branch: 'bitelio-init'});

    expect(git('rev-list', '--count', 'main..bitelio-init')).toBe('1');
  });

  it('takes a branch name that is already taken without clobbering it', async () => {
    git('branch', 'bitelio-init');

    const result = await applyPatch(repo, patch(), {branch: 'bitelio-init'});

    expect(result.branch).not.toBe('bitelio-init');
    expect(currentBranch(repo)).toBe(result.branch);
  });
});

describe('when applying goes wrong halfway', () => {
  it('PUTS THE DEVELOPER BACK where they started', async () => {
    // A tool that fails halfway and leaves somebody on a branch they did not make, with files they
    // did not write, is worse than one that refuses outright.
    const bad = patch({
      create: [
        {path: 'lib/first.ts', contents: 'ok\n', reviewed: false},
        // A directory where a file should go: the write throws after the first one succeeded.
        {path: 'lib/first.ts/nope.ts', contents: 'x\n', reviewed: false},
      ],
      replace: [],
    });

    await expect(applyPatch(repo, bad, {branch: 'bitelio-init'})).rejects.toThrow();

    expect(currentBranch(repo)).toBe('main');
    expect(isClean(repo)).toBe(true);
    expect(() => readFileSync(join(repo, 'lib', 'first.ts'))).toThrow();
  });
});

describe('checking the patch against a baseline', () => {
  /** A repo whose `test` script passes or fails on demand. */
  function withScripts(scripts: Record<string, string>) {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'fixture', scripts}, null, 2));
    git('add', '-A');
    git('commit', '-qm', 'scripts');
  }

  it('OPENS A PR when a check was ALREADY failing before the patch', async () => {
    // The one that matters. Plenty of repositories have a red test on main. Without a baseline,
    // `init` could never produce a pull request for any of them — and would tell the developer it
    // broke something it never touched.
    withScripts({test: 'exit 1'});

    const verdict = await verifyPatch(repo, patch(), {branch: 'bitelio-init', testCommand: 'npm test'});

    expect(verdict.safe).toBe(true);
    expect(verdict.checks[0]).toMatchObject({name: 'npm test', before: false, after: false});
  });

  it('OPENS NO PR when a check that passed before fails now', async () => {
    // `exit 0` while `lib/bitelio.ts` is absent, `exit 1` once it exists — the patch breaks it.
    withScripts({test: 'test ! -f lib/bitelio.ts'});

    const verdict = await verifyPatch(repo, patch(), {branch: 'bitelio-init', testCommand: 'npm test'});

    expect(verdict.safe).toBe(false);
    expect(verdict.checks[0]).toMatchObject({before: true, after: false});
  });

  it('opens a PR when the check passed before and still passes', async () => {
    withScripts({test: 'exit 0'});

    const verdict = await verifyPatch(repo, patch(), {branch: 'bitelio-init', testCommand: 'npm test'});

    expect(verdict.safe).toBe(true);
  });

  it('RUNS NOTHING and says so when the repository has no test command', async () => {
    // Silence here would read as "checked, and fine". The pull request has to say that nothing was
    // run, because that changes how much the reviewer should trust it.
    const verdict = await verifyPatch(repo, patch(), {branch: 'bitelio-init', testCommand: null});

    expect(verdict.checks).toEqual([]);
    expect(verdict.safe).toBe(true);
    expect(verdict.ranNothing).toBe(true);
  });

  it('leaves the branch applied when the verdict is safe', async () => {
    withScripts({test: 'exit 0'});

    await verifyPatch(repo, patch(), {branch: 'bitelio-init', testCommand: 'npm test'});

    expect(currentBranch(repo)).toBe('bitelio-init');
  });

  it('PUTS THE DEVELOPER BACK when the verdict is not safe', async () => {
    // A patch that breaks the build is not something to leave on somebody's disk for them to
    // discover. It is described, and undone.
    withScripts({test: 'test ! -f lib/bitelio.ts'});

    await verifyPatch(repo, patch(), {branch: 'bitelio-init', testCommand: 'npm test'});

    expect(currentBranch(repo)).toBe('main');
    expect(isClean(repo)).toBe(true);
  });

  it('keeps the failing output, so the reason is readable', async () => {
    withScripts({test: 'echo "the specific reason" && exit 1'});

    const verdict = await verifyPatch(repo, patch(), {branch: 'bitelio-init', testCommand: 'npm test'});

    expect(verdict.checks[0]?.output).toContain('the specific reason');
  });
});

describe('turning a plain directory into a repository', () => {
  let plain: string;

  beforeEach(() => {
    plain = mkdtempSync(join(tmpdir(), 'bitelio-plain-'));
    writeFileSync(join(plain, 'package.json'), JSON.stringify({name: 'no-git-here'}));
    mkdirSync(join(plain, 'app'), {recursive: true});
    writeFileSync(join(plain, 'app', 'handler.ts'), 'export const handler = 1;\n');

    // `initialiseRepository` commits, and a commit needs an identity. Supplied through the
    // environment rather than `git config --global`, so this never reads or writes the machine's
    // own configuration — a CI runner has none, and the first version of this block called
    // `git config --global --get user.email`, which THROWS when there is none. That took the whole
    // release down. A test that depends on how the developer's laptop is configured is not a test;
    // this is the second time in this package, after the one that assumed `gh` was absent.
    process.env.GIT_AUTHOR_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
    process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  });

  afterEach(() => {
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    rmSync(plain, {recursive: true, force: true});
  });

  it('leaves it usable: a repository with everything already committed', async () => {
    // Refusing outright was the first behaviour, and it sent people away over two commands that
    // `create-next-app` runs for them anyway. What `init` needs is a branch to put its work on, and
    // this is the smallest thing that provides one.
    initialiseRepository(plain);

    expect(isGitRepository(plain)).toBe(true);
    expect(isClean(plain)).toBe(true);
  });

  it('commits what was already there, so nothing of theirs is lost in the branch', async () => {
    initialiseRepository(plain);

    const tracked = execFileSync('git', ['ls-files'], {cwd: plain, encoding: 'utf8'});
    expect(tracked).toContain('package.json');
    expect(tracked).toContain('app/handler.ts');
  });

  it('makes the patch applicable, which is the whole reason it exists', async () => {
    initialiseRepository(plain);

    const result = await applyPatch(
      plain,
      {replace: [{path: 'app/handler.ts', contents: 'export const handler = 2;\n', reviewed: true}], create: []},
      {branch: 'bitelio-init'},
    );

    expect(result.branch).toBe('bitelio-init');
    expect(readFileSync(join(plain, 'app', 'handler.ts'), 'utf8')).toContain('handler = 2');
  });

  it('is undone by removing .git, which is what the CLI tells them', async () => {
    initialiseRepository(plain);
    rmSync(join(plain, '.git'), {recursive: true, force: true});

    expect(isGitRepository(plain)).toBe(false);
    // Their files are untouched.
    expect(readFileSync(join(plain, 'app', 'handler.ts'), 'utf8')).toContain('handler = 1');
  });
});
