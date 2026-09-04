import {createInterface} from 'node:readline';
import type {Readable, Writable} from 'node:stream';

/**
 * Terminal input and output, written against Node's own primitives.
 *
 * There are good libraries for this. Using one would cost the `bitelio` package its zero runtime
 * dependencies — a property its README offers as a reason to install it on somebody's production
 * server, and one a prompt loop is not worth spending. What is needed here is a menu, a
 * confirmation, a line of text and some colour, and that is the whole requirement.
 */

export interface Io {
  input: Readable & {isTTY?: boolean};
  output: Writable & {isTTY?: boolean};
}

const defaultIo = (): Io => ({input: process.stdin, output: process.stdout});

/**
 * Whether a human is watching.
 *
 * CI runs `init`. A prompt that waits for a keypress there does not fail, it HANGS — the job sits
 * until the runner's timeout with nothing explaining why, which is the worst way for a tool to
 * behave inside somebody else's pipeline. Every prompt below refuses rather than waits.
 */
export function isInteractive(io: Io = defaultIo()): boolean {
  return Boolean(io.input.isTTY && io.output.isTTY);
}

export class NotInteractiveError extends Error {
  constructor(what: string) {
    super(`${what} needs an interactive terminal, and this one is not. Run it locally, or pass the answer as a flag.`);
    this.name = 'NotInteractiveError';
  }
}

/** ANSI, applied only when the output is a terminal — a redirected log should stay readable. */
function style(io: Io, code: string, text: string): string {
  // Written as `\u001b` rather than a literal ESC: a raw control character in source is
  // invisible in a diff and survives only as long as no tool decides to normalise it.
  return io.output.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const paint = {
  bold: (io: Io, t: string) => style(io, '1', t),
  dim: (io: Io, t: string) => style(io, '2', t),
  red: (io: Io, t: string) => style(io, '31', t),
  green: (io: Io, t: string) => style(io, '32', t),
  yellow: (io: Io, t: string) => style(io, '33', t),
};

export function write(text: string, io: Io = defaultIo()): void {
  io.output.write(`${text}\n`);
}

async function readLine(question: string, io: Io): Promise<string> {
  const rl = createInterface({input: io.input, output: io.output});
  try {
    return await new Promise<string>(resolve => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/** A line of free text. Empty input returns `fallback` when one is given. */
export async function line(question: string, options: {fallback?: string; io?: Io} = {}): Promise<string> {
  const io = options.io ?? defaultIo();
  if (!isInteractive(io)) {
    if (options.fallback !== undefined) return options.fallback;
    throw new NotInteractiveError(question);
  }

  const answer = (await readLine(`${question} `, io)).trim();

  return answer === '' && options.fallback !== undefined ? options.fallback : answer;
}

export async function confirm(question: string, options: {default?: boolean; io?: Io} = {}): Promise<boolean> {
  const fallback = options.default ?? true;
  const answer = await line(`${question} ${fallback ? '[Y/n]' : '[y/N]'}`, {
    io: options.io,
    fallback: fallback ? 'y' : 'n',
  });

  return /^y(es)?$/i.test(answer.trim());
}

export interface MenuChoice<T> {
  /** The single character that picks it. Compared case-insensitively. */
  key: string;
  label: string;
  value: T;
}

/**
 * A single-key menu that redraws on an answer it does not recognise.
 *
 * Redrawing rather than looping in silence: a mistyped key with no feedback reads as a frozen
 * program, and showing the options again is both the fix and the explanation.
 */
export async function menu<T>(question: string, choices: MenuChoice<T>[], io: Io = defaultIo()): Promise<T> {
  if (!isInteractive(io)) throw new NotInteractiveError(question);

  const rendered = choices.map(c => `[${c.key}] ${c.label}`).join(' · ');

  for (;;) {
    const answer = (await readLine(`${question}\n  ${rendered}\n> `, io)).trim().toLowerCase();
    const chosen = choices.find(c => c.key.toLowerCase() === answer);
    if (chosen) return chosen.value;

    const complaint = answer === '' ? '  Pick one of the options above.' : `  "${answer}" is not one of these.`;
    write(paint.yellow(io, complaint), io);
  }
}
