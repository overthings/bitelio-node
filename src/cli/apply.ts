import {execFile, execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

/**
 * Writing to somebody else's repository.
 *
 * The only part of `init` that touches a working tree, so the refusals are the design.
 *
 * **A new branch from HEAD, never the working tree.** With uncommitted changes it stops: an `init`
 * that entangles itself with work in progress is an `init` people run once, and the branch it makes
 * becomes impossible to throw away cleanly.
 *
 * **It puts the developer back on failure.** Half-applied is the worst outcome of the three — worse
 * than refusing, worse than finishing — because the person is left on a branch they did not make
 * with files they did not write, and has to work out which is which.
 *
 * Git is driven through `execFile` with an argument array, never a shell string. Branch names and
 * paths come from a model, and a model that emits `; rm -rf ~` into a template literal is a model
 * that has just run it.
 */

export interface PatchFile {
  path: string;
  contents: string;
  reviewed: boolean;
}

export interface Patch {
  replace: PatchFile[];
  create: PatchFile[];
}

export interface ApplyResult {
  /** The branch actually used, which may not be the one asked for — see `uniqueBranch`. */
  branch: string;
  /** The branch the developer was on, so the caller can say where to go back to. */
  from: string;
  files: string[];
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

export function isGitRepository(repo: string): boolean {
  try {
    return git(repo, 'rev-parse', '--is-inside-work-tree') === 'true';
  } catch {
    return false;
  }
}

/** Clean means clean: `--porcelain` reports untracked files too, and committing somebody's scratch
 * file into the branch we just made is the same mistake as committing their half-finished work. */
export function isClean(repo: string): boolean {
  return git(repo, 'status', '--porcelain') === '';
}

export function currentBranch(repo: string): string {
  return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
}

function branchExists(repo: string, name: string): boolean {
  try {
    git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`);

    return true;
  } catch {
    return false;
  }
}

/** `bitelio-init`, then `-2`, `-3`… Somebody who ran this before has a branch worth keeping. */
function uniqueBranch(repo: string, wanted: string): string {
  if (!branchExists(repo, wanted)) return wanted;

  for (let n = 2; n < 100; n++) {
    const candidate = `${wanted}-${n}`;
    if (!branchExists(repo, candidate)) return candidate;
  }

  throw new Error(`There are already 100 branches called ${wanted}-something. Tidy up first.`);
}

/**
 * Resolve a patch path inside the repository, or refuse.
 *
 * `resolve` then compare, rather than string-matching on `..`: a path can climb out through a
 * symlink or an absolute prefix that no substring check would catch, and this is the last thing
 * standing between a model's output and somebody's home directory.
 */
function insideRepo(repo: string, path: string): string {
  const root = resolve(repo);
  const target = resolve(root, path);
  const inside = relative(root, target);

  if (inside === '' || inside.startsWith('..') || inside.startsWith(`..${sep}`) || resolve(root, inside) !== target) {
    throw new Error(`\`${path}\` is not a path inside this repository.`);
  }

  return target;
}

/**
 * Turn a plain directory into a git repository, with everything in it as the first commit.
 *
 * Offered, never done silently — see the caller. `init`'s whole safety story is that its work lives
 * on a branch you can delete in one command, and without a repository there is no branch and no
 * undo. Refusing outright was the first behaviour here and it was too strict: the only thing wrong
 * with such a directory is that nobody has run two commands in it, and `create-next-app` runs both
 * of them for you.
 *
 * Reversible in the way that matters: `rm -rf .git` puts it back exactly as it was, and no remote
 * is involved.
 */
export function initialiseRepository(repo: string): void {
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  // `-q` is not enough on a repo with no user.name configured; that failure is worth surfacing
  // rather than swallowing, so it is left to throw.
  git(repo, 'commit', '-q', '-m', 'Initial commit');
}

export interface ApplyOptions {
  branch: string;
}

export async function applyPatch(repo: string, patch: Patch, options: ApplyOptions): Promise<ApplyResult> {
  if (!isGitRepository(repo)) {
    throw new Error('This is not a git repository, and `init` opens a pull request. Run `git init` first.');
  }
  if (!isClean(repo)) {
    throw new Error(
      'You have uncommitted changes. Commit or stash them first — `init` works on a branch of its own ' +
        'so you can throw the whole thing away in one command.',
    );
  }

  // Every path is checked BEFORE anything is written, so a bad one in the middle of the list cannot
  // leave half a patch on disk.
  for (const file of [...patch.replace, ...patch.create]) insideRepo(repo, file.path);

  for (const file of patch.replace) {
    // The client-side half of the allowlist. The server enforces its own copy against what the
    // developer approved; this one runs whatever server the CLI was pointed at, and it is what
    // stops a replacement inventing a file.
    if (!existsSync(insideRepo(repo, file.path))) {
      throw new Error(`\`${file.path}\` does not exist here, so it cannot be replaced.`);
    }
  }

  const from = currentBranch(repo);
  const branch = uniqueBranch(repo, options.branch);
  const written: string[] = [];

  git(repo, 'checkout', '-q', '-b', branch);

  try {
    for (const file of [...patch.replace, ...patch.create]) {
      const target = insideRepo(repo, file.path);
      mkdirSync(dirname(target), {recursive: true});
      writeFileSync(target, file.contents);
      written.push(file.path);
    }

    git(repo, 'add', '-A');
    // One commit, so the whole thing is one `git reset` to undo.
    git(repo, 'commit', '-q', '-m', 'Add transactional emails via bitelio init');
  } catch (error) {
    // Back where they started: the branch deleted, the tree as it was. Half-applied is the worst of
    // the three outcomes, because the person has to work out which files were theirs.
    try {
      git(repo, 'checkout', '-q', '--', '.');
      git(repo, 'clean', '-qfd');
      git(repo, 'checkout', '-q', from);
      git(repo, 'branch', '-qD', branch);
    } catch {
      // The cleanup itself failing is worth saying out loud rather than swallowing into the
      // original error, but it must not replace it.
      throw new Error(
        `Applying failed and so did the cleanup. You are on \`${branch}\`; \`git checkout ${from}\` to go back. ` +
          `Original error: ${(error as Error).message}`,
      );
    }

    throw error;
  }

  return {branch, from, files: written};
}

export interface Check {
  name: string;
  /** Whether it passed BEFORE the patch. The whole point of the exercise. */
  before: boolean;
  after: boolean;
  /** Whatever the failing run said, so the reason is readable rather than inferred. */
  output: string;
}

export interface Verdict {
  /** Whether the patch is safe to open a pull request for. */
  safe: boolean;
  checks: Check[];
  /** True when there was nothing to run. Said out loud, never implied. */
  ranNothing: boolean;
  /** Set when `safe`, so the caller knows where the work is. Null when it was undone. */
  branch: string | null;
}

/**
 * Run the checks BEFORE the patch, apply it, and run them again.
 *
 * The baseline is the whole design. Plenty of repositories have a red test on main, and without a
 * before-run `init` could never open a pull request for any of them — worse, it would report that
 * it broke something it never touched. What matters is not whether a check passes; it is whether
 * this patch changed the answer.
 *
 * A patch that breaks something is UNDONE, not left on the disk for somebody to find later.
 */
export async function verifyPatch(
  repo: string,
  patch: Patch,
  options: ApplyOptions & {testCommand: string | null},
): Promise<Verdict> {
  const commands = options.testCommand ? [options.testCommand] : [];

  // Before, on the branch they are on now. Anything that fails here was already failing.
  const baseline = new Map<string, {passed: boolean; output: string}>();
  for (const command of commands) baseline.set(command, await runCheck(repo, command));

  const applied = await applyPatch(repo, patch, options);

  const checks: Check[] = [];
  for (const command of commands) {
    const after = await runCheck(repo, command);
    const before = baseline.get(command)!;
    checks.push({name: command, before: before.passed, after: after.passed, output: after.output});
  }

  // Broken BY this patch: it passed before and does not now. A check that was already red stays
  // red and is reported, not blamed on the patch.
  const broke = checks.some(check => check.before && !check.after);

  if (broke) {
    git(repo, 'checkout', '-q', applied.from);
    git(repo, 'branch', '-qD', applied.branch);

    return {safe: false, checks, ranNothing: commands.length === 0, branch: null};
  }

  return {safe: true, checks, ranNothing: commands.length === 0, branch: applied.branch};
}

/** For the caller: run a command in the repository and report whether it passed. Never throws. */
export async function runCheck(repo: string, command: string): Promise<{passed: boolean; output: string}> {
  try {
    // A shell, deliberately: `test` in package.json is a shell command ("jest --ci", "a && b"), and
    // running it any other way would mean reimplementing a shell. The command comes from the
    // developer's own package.json, never from the model.
    const {stdout, stderr} = await run('sh', ['-c', command], {cwd: repo, timeout: 10 * 60_000});

    return {passed: true, output: `${stdout}${stderr}`.trim()};
  } catch (error) {
    const failure = error as {stdout?: string; stderr?: string; message: string};

    return {passed: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() || failure.message};
  }
}

/** Where to go to open the pull request by hand, when `gh` is not installed. */
export function compareUrl(repo: string, branch: string): string | null {
  try {
    const origin = git(repo, 'remote', 'get-url', 'origin');
    const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(origin);
    if (!match) return null;

    return `https://github.com/${match[1]}/${match[2]}/compare/${encodeURIComponent(branch)}?expand=1`;
  } catch {
    return null;
  }
}
