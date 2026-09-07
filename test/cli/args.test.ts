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

  it('reads init and its flags, in any order', () => {
    expect(parseArgs(['init'])).toEqual({name: 'init', dryRun: false, yes: false, projectId: null});
    expect(parseArgs(['init', '--dry-run'])).toEqual({name: 'init', dryRun: true, yes: false, projectId: null});
    expect(parseArgs(['init', '--yes', '--dry-run'])).toEqual({name: 'init', dryRun: true, yes: true, projectId: null});
  });

  it('reads --project in both spellings', () => {
    // It exists because the non-interactive refusal tells people to pass it. A message that names
    // a flag the parser does not have is worse than no message.
    expect(parseArgs(['init', '--project=p_123'])).toMatchObject({projectId: 'p_123'});
    expect(parseArgs(['init', '--project', 'p_123'])).toMatchObject({projectId: 'p_123'});
  });

  it('refuses --project with nothing after it', () => {
    expect(parseArgs(['init', '--project'])).toMatchObject({name: 'error'});
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

describe('the version it reports', () => {
  it('is the one in package.json', async () => {
    // `0.2.0` shipped announcing itself as `0.1.0`: the version was a hand-written constant in
    // main.ts, and `npm version` writes package.json and knows nothing about that file. Two places
    // that must agree, with nothing making them — this is the thing making them.
    //
    // It BUILDS first, rather than reading whatever `dist` happens to hold. The first version of
    // this test asserted against the existing artefact and went red the moment `npm version`
    // bumped the manifest without a rebuild — which is the normal state right after a bump, and
    // says nothing about whether the code is correct. What is worth pinning is that a build FROM
    // this package.json reports THIS version, which is exactly what `prepublishOnly` does before
    // every publish.
    const {execFileSync} = await import('node:child_process');
    const {readFileSync} = await import('node:fs');
    const {fileURLToPath} = await import('node:url');
    const {join} = await import('node:path');

    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const {version} = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {version: string};

    execFileSync('npm', ['run', 'build'], {cwd: root, stdio: 'ignore'});

    expect(execFileSync('node', [join(root, 'dist', 'cli.js'), '--version'], {encoding: 'utf8'}).trim()).toBe(
      version,
    );
  }, 60_000);
});
