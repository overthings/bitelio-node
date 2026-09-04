import {describe, expect, it} from 'vitest';

import {parseArgs} from '../../src/cli/main.js';

/**
 * Argument parsing, hand-rolled for the same reason the prompts are: a dependency here would cost
 * the package its zero-runtime-dependency property, and there are two flags.
 *
 * The assertion that earns its place is the last one. A mistyped `--dry-runn` that was quietly
 * ignored would run for real against somebody's repository, and a tool only gets to do that once.
 */
describe('parseArgs', () => {
  it('shows help for no arguments, --help, -h and help', () => {
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      expect(parseArgs(argv), JSON.stringify(argv)).toEqual({name: 'help'});
    }
  });

  it('prints the version for --version and -v', () => {
    expect(parseArgs(['--version'])).toEqual({name: 'version'});
    expect(parseArgs(['-v'])).toEqual({name: 'version'});
  });

  it('reads init and its two flags, in any order', () => {
    expect(parseArgs(['init'])).toEqual({name: 'init', dryRun: false, yes: false});
    expect(parseArgs(['init', '--dry-run'])).toEqual({name: 'init', dryRun: true, yes: false});
    expect(parseArgs(['init', '--yes', '--dry-run'])).toEqual({name: 'init', dryRun: true, yes: true});
  });

  it('refuses an unknown command, and says what to type instead', () => {
    const parsed = parseArgs(['innit']);

    expect(parsed.name).toBe('error');
    expect((parsed as {message: string}).message).toMatch(/npx bitelio init/);
  });

  it('REFUSES a mistyped flag rather than ignoring it', () => {
    // The one that matters. `--dry-runn` silently dropped means a run the developer believed was a
    // preview, against their repository.
    const parsed = parseArgs(['init', '--dry-runn']);

    expect(parsed.name).toBe('error');
    expect((parsed as {message: string}).message).toMatch(/--dry-runn/);
  });
});
