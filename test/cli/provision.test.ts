import {PassThrough} from 'node:stream';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {chooseProject, provision, type ProvisionApi} from '../../src/cli/provision.js';

/**
 * Picking a project, and showing the key.
 *
 * The two failures worth designing against: writing drafted emails into a project the person did
 * not choose, and printing a key that delivers real mail without saying so. The second is why
 * every path here mentions the word "test".
 */

let printed = '';

function io(typed: string[] = []) {
  const input = new PassThrough() as PassThrough & {isTTY?: boolean};
  const output = new PassThrough() as PassThrough & {isTTY?: boolean};
  input.isTTY = true;
  output.isTTY = true;

  const queued = [...typed];
  const answer = () => {
    const next = queued.shift();
    if (next !== undefined) setTimeout(() => input.write(`${next}\n`), 5);
  };
  output.on('data', (c: Buffer) => {
    printed += c.toString();
    answer();
  });
  setTimeout(answer, 5);

  return {input, output};
}

/** Not a terminal — what CI gives you. */
function pipe() {
  const output = new PassThrough() as PassThrough & {isTTY?: boolean};
  output.on('data', (c: Buffer) => {
    printed += c.toString();
  });
  return {input: new PassThrough(), output};
}

function api(projects: {id: string; name: string}[], result: Record<string, unknown> = {}): ProvisionApi {
  return {
    projects: vi.fn(async () => projects),
    provision: vi.fn(async () => ({
      projectId: 'p1',
      projectName: 'my-app',
      created: true,
      key: {plaintext: 'sk_test_abc123', prefix: 'sk_test_abc12345'},
      existingKeyPrefix: null,
      liveSendingUnlocksAt: null,
      ...result,
    })),
  };
}

beforeEach(() => {
  printed = '';
});

describe('choosing a project', () => {
  it('creates one without asking when the account has none', async () => {
    // Nothing to choose between, so nothing to ask about.
    expect(await chooseProject(api([]), {io: io(), suggestedName: 'my-app'})).toEqual({
      projectId: null,
      name: 'my-app',
    });
  });

  it('ASKS before using the only project there is', async () => {
    // "You only have one" is not consent. The one project may be the person's live account.
    const chosen = await chooseProject(api([{id: 'p1', name: 'Production'}]), {io: io(['y']), suggestedName: 'x'});

    expect(printed).toContain('Production');
    expect(chosen.projectId).toBe('p1');
  });

  it('creates a new one when the person declines the existing project', async () => {
    const chosen = await chooseProject(api([{id: 'p1', name: 'Production'}]), {io: io(['n']), suggestedName: 'my-app'});

    expect(chosen).toEqual({projectId: null, name: 'my-app'});
  });

  it('offers a menu when there are several, and never picks for them', async () => {
    const chosen = await chooseProject(
      api([
        {id: 'p1', name: 'Production'},
        {id: 'p2', name: 'Staging'},
      ]),
      {io: io(['2']), suggestedName: 'x'},
    );

    expect(chosen.projectId).toBe('p2');
  });

  it('REFUSES to choose when nobody is watching and there is a choice to make', async () => {
    // In CI, with projects on the account, silently guessing is how drafted emails land in a live
    // project. Refusing names the fix: pass the project id.
    await expect(
      chooseProject(api([{id: 'p1', name: 'Production'}]), {io: pipe(), suggestedName: 'x'}),
    ).rejects.toThrow(/--project/);
  });

  it('takes --project without asking anything', async () => {
    // What the refusal above tells people to do, so it has to actually work — unattended, with
    // several projects on the account.
    const chosen = await chooseProject(
      api([
        {id: 'p1', name: 'Production'},
        {id: 'p2', name: 'Staging'},
      ]),
      {io: pipe(), suggestedName: 'x', projectId: 'p2'},
    );

    expect(chosen).toEqual({projectId: 'p2', name: 'Staging'});
  });

  it('refuses a --project the account does not have, rather than creating one silently', async () => {
    await expect(
      chooseProject(api([{id: 'p1', name: 'Production'}]), {io: pipe(), suggestedName: 'x', projectId: 'nope'}),
    ).rejects.toThrow(/nope/);
  });

  it('--yes reuses the only project instead of prompting', async () => {
    const chosen = await chooseProject(api([{id: 'p1', name: 'Production'}]), {
      io: pipe(),
      suggestedName: 'x',
      yes: true,
    });

    expect(chosen).toEqual({projectId: 'p1', name: 'Production'});
  });

  it('--yes still REFUSES to pick between several', async () => {
    // "Take the default" is only meaningful where there is one. Choosing arbitrarily between two
    // live projects is exactly the mistake this whole path exists to avoid.
    await expect(
      chooseProject(
        api([
          {id: 'p1', name: 'Production'},
          {id: 'p2', name: 'Staging'},
        ]),
        {io: pipe(), suggestedName: 'x', yes: true},
      ),
    ).rejects.toThrow(/--project/);
  });

  it('still creates one unattended when there is nothing to choose between', async () => {
    expect(await chooseProject(api([]), {io: pipe(), suggestedName: 'my-app'})).toEqual({
      projectId: null,
      name: 'my-app',
    });
  });
});

describe('showing the key', () => {
  it('prints it once, and says plainly that it sends nothing', async () => {
    const client = api([]);

    await provision(client, {io: io(), suggestedName: 'my-app'});

    expect(printed).toContain('sk_test_abc123');
    expect(printed).toMatch(/test key/i);
    expect(printed).toMatch(/deliver|reach|nobody|no email/i);
  });

  it('does not invent a key when a previous run already made one', async () => {
    const client = api([], {key: null, existingKeyPrefix: 'sk_test_old12345'});

    await provision(client, {io: io(), suggestedName: 'my-app'});

    expect(printed).toContain('sk_test_old12345');
    expect(printed).toMatch(/already|previous/i);
  });

  it('says when live sending unlocks, so the wait is not a surprise later', async () => {
    const client = api([], {liveSendingUnlocksAt: new Date(Date.now() + 3 * 3600_000).toISOString()});

    await provision(client, {io: io(), suggestedName: 'my-app'});

    expect(printed).toMatch(/live|real/i);
  });

  it('says nothing about a wait when there is none', async () => {
    const client = api([], {liveSendingUnlocksAt: null});

    await provision(client, {io: io(), suggestedName: 'my-app'});

    expect(printed).not.toMatch(/unlocks/i);
  });
});
