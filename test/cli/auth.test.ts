import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {deviceLogin} from '../../src/cli/auth.js';
import {loadCredentials} from '../../src/cli/credentials.js';

/**
 * The CLI half of the device flow.
 *
 * The server's tests cover what may be issued. These cover how the CLI behaves while it waits,
 * which is where a device flow is actually experienced: a spinner that never explains itself, a
 * poll loop that ignores `slow_down` and gets itself locked out, a token printed to a terminal
 * that scrolls into somebody's screen recording.
 */

let home: string;
let output: PassThrough & {isTTY?: boolean};
let printed: string;

function io() {
  return {input: new PassThrough(), output};
}

/** A server that answers a scripted sequence of polls. */
function server(polls: unknown[], grant: Record<string, unknown> = {}) {
  const queue = [...polls];
  const calls: {path: string; body: unknown}[] = [];

  return {
    calls,
    async post(path: string, body: unknown) {
      calls.push({path, body});
      if (path.endsWith('/device')) {
        return {
          deviceCode: 'device-code-abc',
          userCode: 'BCDF-GHJK',
          verificationUrl: 'https://app.bitelio.com/cli',
          verificationUrlComplete: 'https://app.bitelio.com/cli?code=BCDF-GHJK',
          expiresIn: 600,
          interval: 5,
          ...grant,
        };
      }
      if (queue.length === 0) throw new Error('polled more times than the test scripted');
      return queue.shift();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T10:00:00Z'));
  home = mkdtempSync(join(tmpdir(), 'bitelio-auth-'));
  printed = '';
  output = new PassThrough() as PassThrough & {isTTY?: boolean};
  output.on('data', (c: Buffer) => {
    printed += c.toString();
  });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(home, {recursive: true, force: true});
});

/**
 * The injected `sleep` MOVES THE CLOCK, because the real one does.
 *
 * A no-op stub was the first version, and it made the expiry test hang on a deadline that could
 * never arrive: `Date.now()` stood still while the poll loop ran forever. A double that leaves out
 * the one side effect the code depends on tests the opposite of what it claims to.
 */
const options = () => ({
  home,
  io: io(),
  openUrl: vi.fn(async () => true),
  sleep: vi.fn(async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  }),
});

describe('a successful login', () => {
  it('shows the code and the URL before it starts waiting', async () => {
    // Printed BEFORE polling, not after: the person has to be able to act on it while the CLI is
    // the thing waiting for them.
    const api = server([{token: 'the-token'}]);

    await deviceLogin(api, options());

    expect(printed).toContain('BCDF-GHJK');
    expect(printed).toContain('https://app.bitelio.com/cli');
  });

  it('stores the token and does not print it', async () => {
    // A terminal keeps scrollback, and scrollback ends up in screenshots and screen recordings.
    const api = server([{token: 'the-token'}]);

    await deviceLogin(api, options());

    expect(loadCredentials(home)?.token).toBe('the-token');
    expect(printed).not.toContain('the-token');
  });

  it('opens the browser at the URL that already carries the code', async () => {
    const api = server([{token: 'the-token'}]);
    const opts = options();

    await deviceLogin(api, opts);

    expect(opts.openUrl).toHaveBeenCalledWith('https://app.bitelio.com/cli?code=BCDF-GHJK');
  });

  it('carries on when the browser will not open', async () => {
    // Over SSH, in a container, on a headless box — which is the whole reason the code is printed.
    const api = server([{token: 'the-token'}]);
    const opts = {...options(), openUrl: vi.fn(async () => false)};

    await expect(deviceLogin(api, opts)).resolves.toMatchObject({token: 'the-token'});
    expect(printed).toContain('BCDF-GHJK');
  });

  it('sends only the device code when polling, never the user code', async () => {
    const api = server([{error: 'authorization_pending'}, {token: 'the-token'}]);

    await deviceLogin(api, options());

    const polls = api.calls.filter(c => c.path.endsWith('/device/token'));
    expect(polls).toHaveLength(2);
    for (const poll of polls) expect(poll.body).toEqual({deviceCode: 'device-code-abc'});
  });
});

describe('while it waits', () => {
  it('waits the interval the server advertised, not one of its own', async () => {
    const api = server([{error: 'authorization_pending'}, {token: 't'}], {interval: 7});
    const opts = options();

    await deviceLogin(api, opts);

    expect(opts.sleep).toHaveBeenCalledWith(7000);
  });

  it('BACKS OFF when told to slow down', async () => {
    // Ignoring slow_down is how a CLI locks its own user out of a code they are about to approve.
    const api = server([{error: 'slow_down', interval: 5}, {error: 'authorization_pending'}, {token: 't'}]);
    const opts = options();

    await deviceLogin(api, opts);

    const waits = opts.sleep.mock.calls.map(c => c[0]);
    expect(waits[1]).toBeGreaterThan(waits[0] as number);
  });
});

describe('the transport', () => {
  it('names the host it could not reach', async () => {
    // Node's own message is the two words "fetch failed", which says nothing about which host or
    // that a host was involved. Offline, on a VPN, or with a typo'd BITELIO_API_URL is the most
    // likely way this command fails at all.
    const {deviceApi} = await import('../../src/cli/auth.js');
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('fetch failed'))) as typeof fetch;

    try {
      await expect(deviceApi('https://api.example.test').post('/v1/init/device', {})).rejects.toThrow(
        /Could not reach https:\/\/api\.example\.test/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('when it does not work out', () => {
  it('says the person declined, in those words', async () => {
    const api = server([{error: 'denied'}]);

    await expect(deviceLogin(api, options())).rejects.toThrow(/declin|denied/i);
  });

  it('says the code expired and to run the command again', async () => {
    const api = server([{error: 'expired'}]);

    await expect(deviceLogin(api, options())).rejects.toThrow(/again/i);
  });

  it('GIVES UP at the advertised expiry instead of polling forever', async () => {
    // Without this the CLI polls a dead code until someone notices and kills it.
    const api = server(Array.from({length: 500}, () => ({error: 'authorization_pending'})), {
      expiresIn: 30,
      interval: 5,
    });

    await expect(deviceLogin(api, options())).rejects.toThrow(/again|expired/i);
    expect(api.calls.filter(c => c.path.endsWith('/device/token')).length).toBeLessThanOrEqual(7);
  });

  it('refuses to guess at an answer it does not understand', async () => {
    // A newer server sending an error this version has never heard of must stop, not treat the
    // unknown as pending and spin.
    const api = server([{error: 'something_new_entirely'}]);

    await expect(deviceLogin(api, options())).rejects.toThrow(/something_new_entirely/);
  });

  it('leaves no credentials file behind when it fails', async () => {
    const api = server([{error: 'denied'}]);

    await deviceLogin(api, options()).catch(() => {});

    expect(loadCredentials(home)).toBeNull();
  });
});
