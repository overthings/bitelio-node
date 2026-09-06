#!/usr/bin/env node
import {basename, resolve} from 'node:path';

import {currentBranch, isClean, isGitRepository, verifyPatch, type Patch} from './apply.js';
import {deviceApi, deviceLogin, type InitHttp} from './auth.js';
import {askConsent, printDryRun} from './consent.js';
import {loadCredentials, type Credentials} from './credentials.js';
import {build} from './extract.js';
import {paint, write} from './prompt.js';
import {confirm} from './prompt.js';
import {provision, type InitProject, type ProvisionApi, type ProvisionResponse} from './provision.js';
import {buildBody, openPullRequest} from './pullRequest.js';

/**
 * The `bitelio` command.
 *
 * It lives in this package rather than a `bitelio-cli` of its own for one reason: `npx bitelio init`
 * resolves to the package named `bitelio` and to nothing else. A separate package would mean
 * `npx bitelio-cli init`, which is a different and worse command, and the command is the product
 * here as much as anything it does.
 *
 * That choice carries the constraint the whole CLI is written under: this package declares zero
 * runtime dependencies, and installing it into somebody's production server is a decision its README
 * argues for on exactly that basis. Argument parsing, prompts and colour are therefore hand-rolled.
 */

const VERSION = '0.1.0';

const USAGE = `bitelio ${VERSION}

Usage:
  npx bitelio init          Set up email and lifecycle events for the app in this directory
  npx bitelio --help        Show this
  npx bitelio --version     Print the version

init options:
  --dry-run                 Show exactly what would be uploaded, then stop
  --yes                     Take the default for every prompt (for scripted runs)
  --project <id>            Write to this project, without asking
`;

type Command =
  | {name: 'init'; dryRun: boolean; yes: boolean; projectId: string | null}
  | {name: 'help'}
  | {name: 'version'};

/**
 * Deliberately small: two flags and one command.
 *
 * An unknown argument is an error rather than something ignored — a mistyped `--dry-runn` that
 * silently ran for real, against somebody's repository, is the kind of surprise that ends a tool's
 * credibility in one go.
 */
export function parseArgs(argv: string[]): Command | {name: 'error'; message: string} {
  const args = argv.filter(a => a !== '');

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    return {name: 'help'};
  }
  if (args[0] === '--version' || args[0] === '-v') return {name: 'version'};

  if (args[0] !== 'init') {
    return {name: 'error', message: `Unknown command "${args[0]}". Try: npx bitelio init`};
  }

  const rest = args.slice(1);
  let projectId: string | null = null;
  const flags: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--project=')) {
      projectId = arg.slice('--project='.length);
    } else if (arg === '--project') {
      // The value is the next argument. Missing it is an error rather than a null, because
      // `--project` with nothing after it reads as "the project I meant", not as "no project".
      projectId = rest[++i] ?? null;
      if (projectId === null) return {name: 'error', message: '--project needs a project id after it.'};
    } else {
      flags.push(arg);
    }
  }

  const unknown = flags.find(a => a !== '--dry-run' && a !== '--yes');
  if (unknown !== undefined) {
    return {name: 'error', message: `Unknown option "${unknown}" for init. Try: npx bitelio --help`};
  }

  return {name: 'init', dryRun: flags.includes('--dry-run'), yes: flags.includes('--yes'), projectId};
}

/**
 * The branch to open the pull request against — whatever they were on when they ran it.
 *
 * Read BEFORE anything is applied, because by the time the pull request is opened the CLI has
 * moved them onto its own branch and `HEAD` no longer answers the question.
 */
function branchToTargetOr(fallback: string): string {
  try {
    return isGitRepository(process.cwd()) ? currentBranch(process.cwd()) : fallback;
  } catch {
    return fallback;
  }
}

/** Overridable so the flow can be pointed at a development deployment. */
const apiUrl = (): string => process.env.BITELIO_API_URL ?? 'https://api.bitelio.com';

/** The two authenticated calls, over the same transport the device flow used. */
function provisionApi(http: InitHttp): ProvisionApi {
  return {
    projects: async () => ((await http.get('/v1/init/projects')) as {projects: InitProject[]}).projects,
    provision: body => http.post('/v1/init/provision', body) as Promise<ProvisionResponse>,
  };
}

async function init(options: {projectId: string | null; yes: boolean; dryRun: boolean}): Promise<number> {
  const io = {input: process.stdin, output: process.stdout};

  // Read the repository FIRST, and stop here if this is not a stack `init` understands. Signing
  // somebody in, creating a project and minting a key before discovering the tool cannot help them
  // leaves an account behind for nothing.
  // Checked before the model, before the account, before anything: a repository with uncommitted
  // work cannot receive a patch, and discovering that after an analysis has been paid for wastes
  // one of three runs a day on nothing.
  if (!options.dryRun) {
    if (!isGitRepository(process.cwd())) {
      write(paint.red(io, '  This is not a git repository, and `init` finishes by opening a pull request.'), io);
      return 1;
    }
    if (!isClean(process.cwd())) {
      write(paint.red(io, '  You have uncommitted changes. Commit or stash them first.'), io);
      write(paint.dim(io, '  `init` works on a branch of its own, so you can throw the whole thing away at once.'), io);
      return 1;
    }
  }

  const extract = await build(process.cwd());
  if (!extract.supported) {
    write('', io);
    write(paint.red(io, `  ${extract.reason}`), io);
    return 1;
  }

  // `--dry-run` needs no account at all: it reads, redacts, prints, and stops. That is what lets a
  // nervous developer inspect exactly what this tool would take before trusting it with anything.
  if (options.dryRun) {
    printDryRun(extract, io);
    return 0;
  }

  // An existing token is reused rather than re-prompted. Sending someone through a browser they do
  // not need to open is the difference between a tool they run again and one they run once.
  let credentials: Credentials | null = loadCredentials();

  try {
    if (!credentials) {
      credentials = await deviceLogin(deviceApi(apiUrl()), {apiUrl: apiUrl(), io});
    }

    const provisioned = await provision(provisionApi(deviceApi(credentials.apiUrl, credentials.token)), {
      io,
      // The directory it was run in. Not the git remote or the package name: this is a default a
      // person is about to be shown and can override, and the directory is the one thing that is
      // always there and always recognisable.
      suggestedName: basename(resolve(process.cwd())),
      projectId: options.projectId,
      yes: options.yes,
    });

    const targetBranch = branchToTargetOr('main');
    const consent = await askConsent(extract, io);
    if (!consent.approved) {
      write(paint.dim(io, '  Nothing was uploaded.'), io);
      return 1;
    }

    const http = deviceApi(credentials.apiUrl, credentials.token);
    write('', io);
    write(paint.dim(io, '  Reading it…'), io);

    // One prompt, assembled from exactly what the person approved and nothing else. The file list
    // travels separately as the allowlist the server enforces replacements against.
    const proposal = (await http.post('/v1/init/analyse', {
      turn: 'lifecycle',
      projectId: provisioned.projectId,
      prompt: consent.files.map(file => `--- ${file.path} ---\n${file.content}`).join('\n\n'),
      uploadedFiles: consent.files.map(file => file.path),
    })) as {lifecycle?: {events: {name: string; source: string; confidence: string}[]; emails: {trigger: string; subject: string; purpose: string}[]}; text?: string};

    if (!proposal.lifecycle) {
      write(paint.red(io, '  The analysis came back with nothing to propose.'), io);
      return 1;
    }

    write('', io);
    write(`  Found ${proposal.lifecycle.events.length} lifecycle events:`, io);
    write('', io);
    for (const event of proposal.lifecycle.events) {
      const note = event.confidence === 'low' ? paint.yellow(io, ' (unsure)') : '';
      write(`    ${event.name.padEnd(28)} ${paint.dim(io, event.source)}${note}`, io);
    }
    write('', io);
    write(`  It would write ${proposal.lifecycle.emails.length} emails:`, io);
    write('', io);
    for (const email of proposal.lifecycle.emails) {
      write(`    ${paint.bold(io, email.subject)}`, io);
      write(`      ${paint.dim(io, `on ${email.trigger} — ${email.purpose}`)}`, io);
    }

    // The gate the whole two-turn design exists for: the expensive half runs only after a person
    // has seen what it would do and said yes.
    write('', io);
    if (!(await confirm('  Create them?', {io, default: true}))) {
      write(paint.dim(io, '  Nothing was created.'), io);
      return 0;
    }

    write('', io);
    write(paint.dim(io, '  Writing them…'), io);

    const built = (await http.post('/v1/init/analyse', {
      turn: 'patch',
      projectId: provisioned.projectId,
      prompt: `Approved. Write the files for:\n${JSON.stringify(proposal.lifecycle, null, 2)}`,
      uploadedFiles: consent.files.map(file => file.path),
    })) as {patch?: Patch};

    if (!built.patch) {
      write(paint.red(io, '  The model produced no files.'), io);
      return 1;
    }

    // Applied on a branch, checked against a baseline, and undone if it broke something that
    // worked. The baseline is what makes a repository with an already-red test still usable.
    const verdict = await verifyPatch(process.cwd(), built.patch, {
      branch: 'bitelio-init',
      testCommand: extract.detected.testCommand,
    });

    if (!verdict.safe) {
      write('', io);
      write(paint.red(io, '  The patch broke something that was passing, so it was undone.'), io);
      for (const check of verdict.checks.filter(c => c.before && !c.after)) {
        write(paint.dim(io, `    ${check.name}: ${check.output.split('\n').slice(-3).join(' ')}`), io);
      }
      return 1;
    }

    const body = buildBody({
      verdict,
      created: built.patch.create,
      replaced: built.patch.replace,
      unsure: proposal.lifecycle.events.filter(e => e.confidence === 'low'),
      dashboardUrl: `${credentials.apiUrl.replace('//api.', '//app.')}/settings`,
    });

    const opened = await openPullRequest(process.cwd(), verdict.branch!, targetBranch, body);

    write('', io);
    if (opened.url) {
      write(paint.green(io, `  Opened ${opened.url}`), io);
    } else {
      // The branch is the valuable part and it is committed. Losing it because the last optional
      // step failed would be the worst possible trade.
      write(paint.yellow(io, `  ${opened.reason}`), io);
      write(`  The work is on ${paint.bold(io, verdict.branch!)}.`, io);
      if (opened.openManuallyAt) write(`  Open it at ${opened.openManuallyAt}`, io);
    }
  } catch (error) {
    write(paint.red(io, `  ${(error as Error).message}`), io);
    return 1;
  }

  // Releases 3 and 4: the reasoning, the patch and the pull request. The command stops here and
  // says so rather than printing a plausible success — a stub that lies about what it did is worse
  // than no command at all. And it says plainly that the approval was not acted on, because
  // "approved" with nothing after it reads as "sent".
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const command = parseArgs(argv);

  switch (command.name) {
    case 'help':
      write(USAGE);
      return 0;

    case 'version':
      write(VERSION);
      return 0;

    case 'error':
      write(paint.red({input: process.stdin, output: process.stdout}, command.message));
      return 1;

    case 'init':
      return init(command);
  }
}
