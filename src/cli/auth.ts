import {spawn} from 'node:child_process';

import {saveCredentials, type Credentials} from './credentials.js';
import {paint, write, type Io} from './prompt.js';

/**
 * The CLI half of RFC 8628 device authorization.
 *
 * The CLI shows a short code and waits; the human approves in a browser they are already signed
 * into. Nothing secret is typed at a shell prompt, because a pasted API key lives on in
 * `~/.zsh_history` and in the terminal's scrollback long after the person has forgotten it.
 *
 * Everything the flow touches — the clock, the browser, the network — is injected, so the tests
 * can drive a full expiry in a millisecond and assert on what was printed.
 */

interface DeviceGrantResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  expiresIn: number;
  interval: number;
}

type PollResponse = {token: string} | {error: string; interval?: number};

/** Just enough of the HTTP client for this flow, so tests can supply a scripted server. */
export interface DeviceApi {
  post(path: string, body: unknown): Promise<unknown>;
}

export interface DeviceLoginOptions {
  home?: string;
  io?: Io;
  apiUrl?: string;
  openUrl?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Ask the OS to open a URL, and report whether it could.
 *
 * Never throws and never blocks: over SSH, in a container, or on a headless box there is no
 * browser, and that is the ordinary case this flow was designed for rather than an error. The
 * printed code is the fallback, which is why it is printed first.
 */
export async function openUrlInBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  return new Promise(resolve => {
    try {
      const child = spawn(command, args, {stdio: 'ignore', detached: true});
      child.on('error', () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * The two device endpoints over plain fetch.
 *
 * Not `HttpClient`, deliberately. That class refuses to be constructed without an API key, which is
 * a guard worth keeping — and this flow exists precisely because there is no key yet. Loosening it
 * so two unauthenticated calls could share the retry logic would trade a real invariant for fifteen
 * lines. The flow also does not want retries: it is already a poll loop, and a retry inside a poll
 * is just a poll at the wrong interval.
 */
export function deviceApi(baseUrl: string): DeviceApi {
  const root = baseUrl.replace(/\/+$/, '');

  return {
    async post(path: string, body: unknown): Promise<unknown> {
      const response = await fetch(root + path, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
      });

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text === '' ? {} : JSON.parse(text);
      } catch {
        // An HTML error page from a proxy, which is what a misconfigured base URL actually returns.
        throw new Error(`${root} answered ${response.status} with something that is not JSON.`);
      }

      // A poll's refusals arrive as 200 with an `error` field, by design — see the API controller.
      // Anything that is genuinely an HTTP failure is one.
      if (!response.ok) {
        const message = (parsed as {error?: {message?: string} | string})?.error;
        throw new Error(
          typeof message === 'string' ? message : (message?.message ?? `${root} answered ${response.status}.`),
        );
      }

      return parsed;
    },
  };
}

export async function deviceLogin(api: DeviceApi, options: DeviceLoginOptions = {}): Promise<Credentials> {
  const io = options.io;
  const sleep = options.sleep ?? wait;
  const openUrl = options.openUrl ?? openUrlInBrowser;

  const grant = (await api.post('/v1/init/device', {})) as DeviceGrantResponse;
  const url = grant.verificationUrlComplete ?? grant.verificationUrl;

  // Printed BEFORE anything else happens, and before the browser is even attempted. The person has
  // to be able to act on this while the CLI is the thing waiting for them.
  const say = (text: string) => write(text, io);
  say('');
  say(`  Open ${paint.bold(io!, grant.verificationUrl)} and enter this code:`);
  say('');
  say(`      ${paint.bold(io!, grant.userCode)}`);
  say('');

  if (await openUrl(url)) {
    say(paint.dim(io!, '  (opening your browser…)'));
  }
  say(paint.dim(io!, '  Waiting for you to approve…'));

  // The deadline the server advertised, honoured rather than assumed: without it the CLI polls a
  // code that died ten minutes ago until somebody notices and kills it.
  const deadline = Date.now() + grant.expiresIn * 1000;
  let interval = grant.interval * 1000;

  for (;;) {
    await sleep(interval);
    if (Date.now() > deadline) {
      throw new Error('That code expired. Run the command again.');
    }

    const result = (await api.post('/v1/init/device/token', {deviceCode: grant.deviceCode})) as PollResponse;

    if ('token' in result) {
      const credentials: Credentials = {token: result.token, apiUrl: options.apiUrl ?? 'https://api.bitelio.com'};
      const file = saveCredentials(credentials, options.home);
      // The path, never the token: a terminal keeps scrollback, and scrollback ends up in
      // screenshots, in pasted bug reports, and in screen recordings.
      say(paint.green(io!, `  Connected. Saved to ${file}`));

      return credentials;
    }

    switch (result.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        // Back off rather than repeat: ignoring this is how a CLI gets itself locked out of a code
        // its own user is about to approve.
        interval = Math.max(interval * 2, (result.interval ?? 5) * 1000);
        continue;
      case 'denied':
        throw new Error('You declined the request. Nothing was connected.');
      case 'expired':
        throw new Error('That code expired. Run the command again.');
      default:
        // A newer server with an error this version has never heard of. Stop and name it, rather
        // than treat the unknown as pending and spin until the deadline.
        throw new Error(`The server answered with something this version does not understand: ${result.error}`);
    }
  }
}
