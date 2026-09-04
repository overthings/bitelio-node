#!/usr/bin/env node
import {basename, resolve} from 'node:path';

import {deviceApi, deviceLogin, type InitHttp} from './auth.js';
import {loadCredentials, type Credentials} from './credentials.js';
import {paint, write} from './prompt.js';
import {provision, type InitProject, type ProvisionApi, type ProvisionResponse} from './provision.js';

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

/** Overridable so the flow can be pointed at a development deployment. */
const apiUrl = (): string => process.env.BITELIO_API_URL ?? 'https://api.bitelio.com';

/** The two authenticated calls, over the same transport the device flow used. */
function provisionApi(http: InitHttp): ProvisionApi {
  return {
    projects: async () => ((await http.get('/v1/init/projects')) as {projects: InitProject[]}).projects,
    provision: body => http.post('/v1/init/provision', body) as Promise<ProvisionResponse>,
  };
}

async function init(options: {projectId: string | null; yes: boolean}): Promise<number> {
  const io = {input: process.stdin, output: process.stdout};

  // An existing token is reused rather than re-prompted. Sending someone through a browser they do
  // not need to open is the difference between a tool they run again and one they run once.
  let credentials: Credentials | null = loadCredentials();

  try {
    if (!credentials) {
      credentials = await deviceLogin(deviceApi(apiUrl()), {apiUrl: apiUrl(), io});
    }

    await provision(provisionApi(deviceApi(credentials.apiUrl, credentials.token)), {
      io,
      // The directory it was run in. Not the git remote or the package name: this is a default a
      // person is about to be shown and can override, and the directory is the one thing that is
      // always there and always recognisable.
      suggestedName: basename(resolve(process.cwd())),
      projectId: options.projectId,
      yes: options.yes,
    });
  } catch (error) {
    write(paint.red(io, `  ${(error as Error).message}`), io);
    return 1;
  }

  // Releases 2 to 4: reading the repository, proposing a lifecycle, opening the pull request. The
  // command stops here and says so rather than printing a plausible success — a stub that lies
  // about what it did is worse than no command at all.
  write('');
  write(paint.dim(io, '  Next: reading this repository and drafting your emails. Not built yet.'));

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
