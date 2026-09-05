import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {detect, type Detected} from './detect.js';
import {redact} from './redact.js';

/**
 * Assembling what leaves the machine.
 *
 * Two properties carry this file, both about the developer being able to answer for it afterwards.
 *
 * Every file here is justified by a rule, in words on the consent screen. Nothing is included
 * because a model might find it useful — that is what would make the screen theatre.
 *
 * And nothing is dropped silently. Over the cap, files go by priority and the screen says which
 * ones went. A truncated extract produces a worse analysis, and one nobody can account for later.
 */

/** From the design document. Comfortably more than a Next app's handlers and schema come to. */
export const EXTRACT_CAP_BYTES = 100 * 1024;

/**
 * A file that is truncated rather than dropped keeps this much of itself.
 *
 * The Stripe handler is the thing being analysed; an extract without it cannot answer the question
 * it was assembled for. Truncating is the lesser loss, and it is stated.
 */
const TRUNCATION_NOTICE = '\n\n// … truncated by `bitelio init` to fit the upload limit …\n';

export interface ExtractFile {
  path: string;
  /** Exactly the bytes that will be sent. What the screen shows and what the wire carries are one. */
  content: string;
  /** Why this file is here, in words a person can disagree with. */
  why: string;
  /** How many values the secret filter replaced. Zero keeps the screen quiet. */
  redactions: number;
  truncated: boolean;
}

export interface Extract {
  supported: boolean;
  /** Set when `supported` is false — `detect`'s reason, passed through. */
  reason: string | null;
  detected: Detected;
  files: ExtractFile[];
  /** Paths dropped to fit the cap, in the order they went. Never silent. */
  dropped: string[];
  totalBytes: number;
}

/** The label the tree travels under. Not a real path, and deliberately not shaped like one. */
const TREE_LABEL = '(file tree)';

/**
 * Never read, whatever it is called.
 *
 * Not even to inspect. The redaction filter is a heuristic; a `.env` is a file whose entire purpose
 * is holding credentials, and no version of opening one is worth the risk. `.env.example` is
 * covered by the same rule — people paste real keys into those, and the variable NAMES it would
 * contribute are already visible in the handler that reads them.
 */
const IS_ENV_FILE = /(^|\/)\.env(\.|$)/;

/**
 * What each file is read for, and therefore what its absence costs.
 *
 * Excluding the Stripe handler must not read as "makes no difference" — these three events are
 * exactly what that file is opened to find.
 */
const EVENTS_FROM_STRIPE = ['subscription_started', 'payment_failed', 'cancelled'];
const EVENTS_FROM_AUTH = ['signup', 'email_verification'];

export function undetectableWithout(
  path: string,
  handlers: {stripe: {handler: string} | null; auth: {handler: string; provider?: string} | null},
): string[] {
  if (handlers.stripe?.handler === path) return [...EVENTS_FROM_STRIPE];
  if (handlers.auth?.handler === path) return [...EVENTS_FROM_AUTH];

  return [];
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Read a file and pass it through the secret filter. `.env` files return null without being opened.
 */
export async function readForUpload(
  root: string,
  path: string,
): Promise<{content: string; redactions: number} | null> {
  if (IS_ENV_FILE.test(path)) return null;

  try {
    const {text, count} = redact(await readFile(join(root, path), 'utf8'));

    return {content: text, redactions: count};
  } catch {
    return null;
  }
}

export async function build(root: string): Promise<Extract> {
  const detected = await detect(root);

  if (!detected.supported) {
    return {supported: false, reason: detected.reason, detected, files: [], dropped: [], totalBytes: 0};
  }

  /**
   * Assembled in DROP order, most expendable first, so trimming is a matter of taking from the
   * front.
   *
   * Tree, schema, manifest, then the handlers. The tree only says where things are. The schema
   * names a model. The manifest's contribution — dependencies, the test command — has already been
   * read into `detected`, so the file itself is nearly free to lose. The handlers are the thing
   * being analysed, and the Stripe one is last because an extract without it cannot answer the
   * question it was assembled for.
   */
  const planned: {path: string; why: string; read: () => Promise<{content: string; redactions: number} | null>}[] = [];

  const listedTree = detected.tree.filter(path => !IS_ENV_FILE.test(path));
  planned.push({
    path: TREE_LABEL,
    why: `${listedTree.length} paths, no contents`,
    read: async () => ({content: listedTree.join('\n'), redactions: 0}),
  });

  if (detected.dataModel) {
    planned.push({
      path: detected.dataModel.file,
      why: detected.dataModel.userModel
        ? `your ${detected.dataModel.kind} schema — user model \`${detected.dataModel.userModel}\``
        : `your ${detected.dataModel.kind} schema`,
      read: () => readForUpload(root, detected.dataModel!.file),
    });
  }

  // Ahead of the handlers in the drop order, deliberately: everything this file contributes —
  // the dependencies and the test command — has already been read into `detected`, so losing the
  // file itself costs the analysis the least of anything here.
  planned.push({
    path: 'package.json',
    why: 'dependencies and the test command',
    read: () => readForUpload(root, 'package.json'),
  });

  if (detected.auth) {
    planned.push({
      path: detected.auth.handler,
      why: `your ${detected.auth.provider} webhook — ${EVENTS_FROM_AUTH.join(', ')}`,
      read: () => readForUpload(root, detected.auth!.handler),
    });
  }

  if (detected.stripe) {
    planned.push({
      path: detected.stripe.handler,
      why: `your Stripe webhook — ${EVENTS_FROM_STRIPE.join(', ')}`,
      read: () => readForUpload(root, detected.stripe!.handler),
    });
  }

  const loaded: ExtractFile[] = [];
  for (const item of planned) {
    const read = await item.read();
    if (!read) continue;
    loaded.push({path: item.path, content: read.content, why: item.why, redactions: read.redactions, truncated: false});
  }

  // Trim from the front of the drop order until it fits. The last file standing is never dropped —
  // it is truncated instead, because an extract with nothing in it is not a smaller analysis, it is
  // no analysis.
  const dropped: string[] = [];
  let total = loaded.reduce((sum, file) => sum + bytes(file.content), 0);

  while (total > EXTRACT_CAP_BYTES && loaded.length > 1) {
    const [gone] = loaded.splice(0, 1);
    dropped.push(gone!.path);
    total -= bytes(gone!.content);
  }

  if (total > EXTRACT_CAP_BYTES && loaded.length === 1) {
    const only = loaded[0]!;
    const room = EXTRACT_CAP_BYTES - bytes(TRUNCATION_NOTICE);
    only.content = `${only.content.slice(0, room)}${TRUNCATION_NOTICE}`;
    only.truncated = true;
    total = bytes(only.content);
  }

  // Back into reading order for display: the manifest first, then the handlers, then the tree.
  const order = [
    'package.json',
    detected.stripe?.handler,
    detected.auth?.handler,
    detected.dataModel?.file,
    TREE_LABEL,
  ].filter(Boolean) as string[];
  loaded.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));

  return {supported: true, reason: null, detected, files: loaded, dropped, totalBytes: total};
}
