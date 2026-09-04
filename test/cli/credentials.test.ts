import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {loadCredentials, saveCredentials} from '../../src/cli/credentials.js';

/**
 * Where the CLI's token lives on disk.
 *
 * The token is an hour of somebody's account. Every assertion here is about the ways a file like
 * that leaks: readable by other accounts on a shared machine, readable by a stale process after
 * the user logged out, or — the one people actually hit — sitting in a repository because the
 * tool wrote it into the working directory.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bitelio-cli-'));
});

afterEach(() => {
  rmSync(home, {recursive: true, force: true});
});

describe('saving', () => {
  it('writes the file readable only by its owner', () => {
    saveCredentials({token: 'secret-token', apiUrl: 'https://api.bitelio.com'}, home);

    const mode = statSync(join(home, '.bitelio', 'config.json')).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('makes the directory private too', () => {
    // 0600 on the file is undone by a 0755 directory the moment anything is added beside it.
    saveCredentials({token: 'secret-token', apiUrl: 'https://api.bitelio.com'}, home);

    expect((statSync(join(home, '.bitelio')).mode & 0o777).toString(8)).toBe('700');
  });

  it('tightens a DIRECTORY that was already there with loose permissions', () => {
    // The case `mkdirSync(…, {mode})` does not cover: it applies the mode only when it creates the
    // directory. Without the explicit chmod this passed anyway on a fresh machine and left a 0755
    // ~/.bitelio on every machine where one already existed — which is every machine that ran an
    // earlier version.
    mkdirSync(join(home, '.bitelio'), {recursive: true});
    chmodSync(join(home, '.bitelio'), 0o755);

    saveCredentials({token: 't', apiUrl: 'https://api.bitelio.com'}, home);

    expect((statSync(join(home, '.bitelio')).mode & 0o777).toString(8)).toBe('700');
  });

  it('writes to the home directory, never to the working directory', () => {
    // The failure that puts a token in someone's repository, and then in their next commit.
    saveCredentials({token: 'secret-token', apiUrl: 'https://api.bitelio.com'}, home);

    expect(readFileSync(join(home, '.bitelio', 'config.json'), 'utf8')).toContain('secret-token');
  });

  it('tightens a file that was already there with loose permissions', () => {
    // An older version of this tool, or a user who copied the file around.
    mkdirSync(join(home, '.bitelio'), {recursive: true});
    writeFileSync(join(home, '.bitelio', 'config.json'), '{}');
    chmodSync(join(home, '.bitelio', 'config.json'), 0o644);

    saveCredentials({token: 't', apiUrl: 'https://api.bitelio.com'}, home);

    expect((statSync(join(home, '.bitelio', 'config.json')).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('loading', () => {
  it('reads back what it wrote', () => {
    saveCredentials({token: 'secret-token', apiUrl: 'https://api.bitelio.com'}, home);

    expect(loadCredentials(home)).toEqual({token: 'secret-token', apiUrl: 'https://api.bitelio.com'});
  });

  it('returns null when there is nothing there, rather than throwing', () => {
    expect(loadCredentials(home)).toBeNull();
  });

  it('returns null for a corrupt file, rather than crashing the command', () => {
    // A half-written file from an interrupted save should mean "log in again", not a stack trace.
    mkdirSync(join(home, '.bitelio'), {recursive: true});
    writeFileSync(join(home, '.bitelio', 'config.json'), '{not json');

    expect(loadCredentials(home)).toBeNull();
  });

  it('returns null for a file with no token in it', () => {
    mkdirSync(join(home, '.bitelio'), {recursive: true});
    writeFileSync(join(home, '.bitelio', 'config.json'), JSON.stringify({apiUrl: 'https://api.bitelio.com'}));

    expect(loadCredentials(home)).toBeNull();
  });
});
