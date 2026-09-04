import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

/**
 * The CLI's token on disk.
 *
 * In the home directory, never the working directory. A tool that drops a credential file where it
 * was run puts it in somebody's repository, and from there into a commit — the `.env` mistake, made
 * by the tool instead of by the person.
 *
 * 0600 on the file and 0700 on the directory. The directory matters as much: 0600 on one file is
 * undone the moment anything else is written beside it under a 0755 parent.
 */
export interface Credentials {
  token: string;
  apiUrl: string;
}

const DIR_NAME = '.bitelio';
const FILE_NAME = 'config.json';

function paths(home: string) {
  const dir = join(home, DIR_NAME);
  return {dir, file: join(dir, FILE_NAME)};
}

export function saveCredentials(credentials: Credentials, home: string = homedir()): string {
  const {dir, file} = paths(home);

  mkdirSync(dir, {recursive: true, mode: 0o700});
  // `mkdirSync` honours `mode` only when it creates the directory, and applies the process umask
  // even then. An existing directory keeps whatever it had, so set it either way.
  chmodSync(dir, 0o700);

  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, {mode: 0o600});
  // Same reason: `mode` in writeFileSync applies to creation, not to a file that already exists.
  // Someone who copied this file around, or an older version of this tool, leaves a 0644 behind.
  chmodSync(file, 0o600);

  return file;
}

/**
 * Read the token back, or null.
 *
 * Never throws. Every failure here — no file, half a file from an interrupted write, a file with
 * no token in it — means the same thing to the caller: log in again. A stack trace would say that
 * much less clearly.
 */
export function loadCredentials(home: string = homedir()): Credentials | null {
  const {file} = paths(home);
  if (!existsSync(file)) return null;

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Credentials>;
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;

    return {token: parsed.token, apiUrl: parsed.apiUrl ?? 'https://api.bitelio.com'};
  } catch {
    return null;
  }
}

/** Where the file is, for messages that tell someone what to delete. */
export function credentialsPath(home: string = homedir()): string {
  return paths(home).file;
}
