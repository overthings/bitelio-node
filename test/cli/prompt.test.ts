import {PassThrough} from 'node:stream';
import {describe, expect, it} from 'vitest';

import {confirm, isInteractive, line, menu, NotInteractiveError, paint} from '../../src/cli/prompt.js';

/**
 * The prompt layer exists so the package can keep its zero runtime dependencies, so it earns its own
 * tests. The ones that matter are at the top: prompts must REFUSE rather than hang when nobody is
 * watching. CI runs `init`, and a prompt waiting for a keypress there is a job that sits until the
 * runner's timeout with nothing on screen explaining why.
 */

/** A fake terminal that types `typed` one line at a time, in response to each write. */
function tty(typed: string[] = []) {
  const input = new PassThrough() as PassThrough & {isTTY?: boolean};
  const output = new PassThrough() as PassThrough & {isTTY?: boolean};
  input.isTTY = true;
  output.isTTY = true;

  let seen = '';
  const queued = [...typed];
  const answerNext = () => {
    const next = queued.shift();
    if (next !== undefined) setTimeout(() => input.write(`${next}\n`), 5);
  };

  output.on('data', (chunk: Buffer) => {
    seen += chunk.toString();
    answerNext();
  });
  setTimeout(answerNext, 5);

  return {io: {input, output}, seen: () => seen};
}

/** Not a terminal: a pipe, which is what CI gives you. */
function pipe() {
  return {io: {input: new PassThrough(), output: new PassThrough()}};
}

describe('isInteractive', () => {
  it('is true only when both ends are a terminal', () => {
    expect(isInteractive(tty().io)).toBe(true);
    expect(isInteractive(pipe().io)).toBe(false);
  });
});

describe('when nobody is watching', () => {
  it('a menu refuses instead of hanging', async () => {
    await expect(menu('Pick', [{key: 'a', label: 'A', value: 1}], pipe().io)).rejects.toBeInstanceOf(
      NotInteractiveError,
    );
  });

  it('a free-text prompt refuses when it has no fallback', async () => {
    await expect(line('Your site URL?', {io: pipe().io})).rejects.toBeInstanceOf(NotInteractiveError);
  });

  it('a prompt WITH a fallback answers itself, so a scripted run still works', async () => {
    expect(await line('Your site URL?', {io: pipe().io, fallback: 'https://example.com'})).toBe(
      'https://example.com',
    );
  });

  it('a confirmation takes its default rather than blocking', async () => {
    expect(await confirm('Create them?', {io: pipe().io, default: true})).toBe(true);
    expect(await confirm('Overwrite?', {io: pipe().io, default: false})).toBe(false);
  });

  it('the error names what it was asking and what to do about it', async () => {
    const error = await menu('Pick a file', [{key: 'a', label: 'A', value: 1}], pipe().io).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/Pick a file/);
    expect((error as Error).message).toMatch(/interactive terminal/);
  });
});

describe('menu', () => {
  it('returns the value behind the key', async () => {
    const chosen = await menu(
      'Pick',
      [
        {key: 'a', label: 'A', value: 'first'},
        {key: 'b', label: 'B', value: 'second'},
      ],
      tty(['b']).io,
    );

    expect(chosen).toBe('second');
  });

  it('is case-insensitive', async () => {
    expect(await menu('Pick', [{key: 'a', label: 'A', value: 'first'}], tty(['A']).io)).toBe('first');
  });

  it('redraws on an answer it does not recognise, rather than looping in silence', async () => {
    // A mistyped key with no feedback reads as a frozen program.
    const {io, seen} = tty(['z', 'a']);

    expect(await menu('Pick', [{key: 'a', label: 'A', value: 'first'}], io)).toBe('first');
    expect(seen()).toMatch(/"z" is not one of these/);
  });

  it('says something useful about an empty answer too', async () => {
    const {io, seen} = tty(['', 'a']);

    await menu('Pick', [{key: 'a', label: 'A', value: 'first'}], io);

    expect(seen()).toMatch(/Pick one of the options above/);
  });
});

describe('confirm', () => {
  it('treats a bare Enter as the default', async () => {
    expect(await confirm('Create them?', {io: tty(['']).io, default: true})).toBe(true);
    expect(await confirm('Overwrite?', {io: tty(['']).io, default: false})).toBe(false);
  });

  it('reads yes and no in either spelling', async () => {
    expect(await confirm('Go?', {io: tty(['yes']).io})).toBe(true);
    expect(await confirm('Go?', {io: tty(['n']).io})).toBe(false);
  });
});

describe('paint', () => {
  it('adds no escapes when the output is redirected', () => {
    // A CI log full of escape codes is a log nobody reads.
    expect(paint.red(pipe().io, 'careful')).toBe('careful');
  });

  it('colours a real terminal', () => {
    expect(paint.red(tty().io, 'careful')).toContain('[31m');
  });
});
