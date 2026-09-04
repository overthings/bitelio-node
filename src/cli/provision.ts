import {confirm, isInteractive, menu, paint, write, type Io} from './prompt.js';

/**
 * Choosing where `init` will write, and showing the key it gets.
 *
 * The choice is always the person's. A tool that picks a project for you is a tool that one day
 * writes drafted emails into somebody's live account, and they find out from the dashboard rather
 * than from the tool. The only case it decides alone is the one with nothing to decide: an account
 * with no projects at all.
 */

export interface InitProject {
  id: string;
  name: string;
}

export interface ProvisionResponse {
  projectId: string;
  projectName: string;
  created: boolean;
  key: {plaintext: string; prefix: string} | null;
  existingKeyPrefix: string | null;
  /** ISO string over the wire; null when the project may already send for real. */
  liveSendingUnlocksAt: string | null;
}

export interface ProvisionApi {
  projects(): Promise<InitProject[]>;
  provision(body: {projectId: string | null; name: string}): Promise<ProvisionResponse>;
}

export interface ProvisionOptions {
  io: Io;
  /** Default name for a new project — the CLI passes the directory it was run in. */
  suggestedName: string;
  /** `--project`: the answer given up front, so nothing is asked. */
  projectId?: string | null;
  /** `--yes`: take the default. Only meaningful where there IS one — see below. */
  yes?: boolean;
}

export async function chooseProject(
  api: ProvisionApi,
  {io, suggestedName, projectId, yes}: ProvisionOptions,
): Promise<{projectId: string | null; name: string}> {
  const projects = await api.projects();

  if (projectId) {
    // Answered up front, so nothing is asked. Still checked against the account: a typo that
    // silently created a project called `mi-tienda` instead of writing to the one that was meant
    // is a mistake nobody would notice until they went looking for the emails.
    const named = projects.find(p => p.id === projectId);
    if (!named) {
      throw new Error(`No project ${projectId} on this account. Run without --project to see the list.`);
    }

    return {projectId: named.id, name: named.name};
  }

  if (projects.length === 0) {
    // Nothing to choose between, so nothing to ask. This is also the path that makes a scripted
    // `init` on a fresh account work.
    return {projectId: null, name: suggestedName};
  }

  if (projects.length === 1 && yes) {
    // `--yes` means "take the default", and here there is one.
    return {projectId: projects[0]!.id, name: projects[0]!.name};
  }

  if (!isInteractive(io) || yes) {
    // Refusing rather than guessing, and naming a flag that exists. In CI, on an account that
    // already has projects, a guess is how a live project acquires drafts nobody asked for — and
    // `--yes` does not rescue it, because "the default" is not a thing when there are two live
    // projects to pick between.
    throw new Error(
      `This account has ${projects.length} project${projects.length === 1 ? '' : 's'} and nothing to choose with. ` +
        `Pass --project <id>, or run it in a terminal.`,
    );
  }

  if (projects.length === 1) {
    // "You only have one" is not consent — the one project may be the person's live account.
    const only = projects[0]!;
    const reuse = await confirm(`  Use your project ${paint.bold(io, only.name)}?`, {io, default: true});

    return reuse ? {projectId: only.id, name: only.name} : {projectId: null, name: suggestedName};
  }

  const chosen = await menu(
    '  Which project should this write to?',
    [
      ...projects.map((project, index) => ({
        key: String(index + 1),
        label: project.name,
        value: project.id as string | null,
      })),
      {key: 'n', label: `new project "${suggestedName}"`, value: null},
    ],
    io,
  );

  return {projectId: chosen, name: chosen === null ? suggestedName : (projects.find(p => p.id === chosen)?.name ?? suggestedName)};
}

export async function provision(api: ProvisionApi, options: ProvisionOptions): Promise<ProvisionResponse> {
  const {io} = options;
  const choice = await chooseProject(api, options);
  const result = await api.provision(choice);

  const say = (text: string) => write(text, io);
  say('');
  say(result.created ? `  Created the project ${paint.bold(io, result.projectName)}.` : `  Using ${paint.bold(io, result.projectName)}.`);
  say('');

  if (result.key) {
    // Shown once, because it is stored as a hash and cannot be shown again. Said plainly, because
    // a key that silently delivered nothing would be a worse surprise than one that refused.
    say(`  Your ${paint.bold(io, 'test key')} — copy it into your .env now, it is not shown again:`);
    say('');
    say(`      ${result.key.plaintext}`);
    say('');
    say(paint.dim(io, '  A test key does everything a live one does and stops before the provider.'));
    say(paint.dim(io, '  Nothing it sends reaches anybody. Mint a live key in Settings when you are ready.'));
  } else {
    // Not re-minted on purpose: revoking the old one would break the .env written on the first run.
    say(`  A key from a previous run is already on this project (${result.existingKeyPrefix}…).`);
    say(paint.dim(io, '  Keeping it, so the .env you already wrote keeps working. Rotate it in Settings.'));
  }

  if (result.liveSendingUnlocksAt) {
    // Said now rather than discovered later, when a send is refused with no explanation.
    const when = new Date(result.liveSendingUnlocksAt);
    say('');
    say(paint.yellow(io, `  This project can send for real from ${when.toLocaleTimeString()} — new accounts wait a few hours.`));
  }

  return result;
}
