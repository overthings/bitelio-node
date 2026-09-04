#!/usr/bin/env node
import {paint, write} from './prompt.js';

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
`;

type Command = {name: 'init'; dryRun: boolean; yes: boolean} | {name: 'help'} | {name: 'version'};

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
  const unknown = rest.find(a => a !== '--dry-run' && a !== '--yes');
  if (unknown !== undefined) {
    return {name: 'error', message: `Unknown option "${unknown}" for init. Try: npx bitelio --help`};
  }

  return {name: 'init', dryRun: rest.includes('--dry-run'), yes: rest.includes('--yes')};
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
      // Releases 2 to 4. The command exists and refuses honestly rather than pretending: a stub
      // that printed a plausible success would be worse than no command at all.
      write('`bitelio init` is not built yet — this release only wires up the command.');
      return 1;
  }
}
