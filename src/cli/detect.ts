import {readdir, readFile, stat} from 'node:fs/promises';
import {join, relative, sep} from 'node:path';

/**
 * Reading a repository well enough to know what `init` can and cannot do with it.
 *
 * Pattern matching only. No model runs here, and that is what makes the consent screen honest: every
 * file proposed for upload can be justified by a rule, and a file no rule can justify does not get
 * proposed. If selection were a model's judgement, the screen would be theatre.
 *
 * Handlers are located by the call that MAKES them handlers — `stripe.webhooks.constructEvent`, a
 * Svix `verify` — not by their path. Where somebody files a webhook route is a convention, and
 * conventions vary; verifying a signature is what a webhook handler does.
 *
 * When it cannot find Next or Stripe it stops, and says what it looked for. v1 understands one
 * stack; the version that guesses produces a pull request nobody can test, which is worse than the
 * version that admits it.
 */

export interface Framework {
  name: 'next';
  version: string | null;
  /** `null` when neither directory exists — Next without a router is a repository mid-setup. */
  router: 'app' | 'pages' | null;
}

export interface HandlerLocation {
  /** Repo-relative, forward slashes, whatever the platform. */
  handler: string;
}

export interface AuthLocation extends HandlerLocation {
  provider: 'clerk';
}

export interface DataModel {
  kind: 'prisma' | 'drizzle';
  file: string;
  /** What the user table is actually called, so events can be typed against it. */
  userModel: string | null;
}

export interface Detected {
  supported: boolean;
  /** Set when `supported` is false: what was looked for, so the answer is arguable. */
  reason: string | null;
  framework: Framework | null;
  stripe: HandlerLocation | null;
  auth: AuthLocation | null;
  dataModel: DataModel | null;
  /** Exactly as written in package.json. Never invented — see below. */
  testCommand: string | null;
  /**
   * What was looked for and not found, named.
   *
   * The consent screen has to be able to say "no signup handler, so `signup` and
   * `email_verification` cannot be detected". An absent key reads as nothing to say, which is a
   * different thing from nothing being there.
   */
  missing: string[];
  /** Paths only, no contents. */
  tree: string[];
  /** How many paths the tree was trimmed by, so the screen can say so rather than imply completeness. */
  treeTruncatedBy: number;
}

/**
 * How deep the walk goes.
 *
 * The design document said three levels. Three levels cannot see `app/api/webhooks/stripe/route.ts`
 * — a Next App Router route is five segments by construction — so a tree bounded that way would
 * contain none of the routes, which are the only thing anyone wants to look at. The bound exists to
 * keep the extract small, so it is enforced on the number of paths instead, where it belongs.
 */
const TREE_DEPTH = 8;

/**
 * A tree longer than this is dropped to its first `MAX_TREE_PATHS` entries, and the consent screen
 * is told how many were left out. A silently truncated tree is a worse analysis nobody can account
 * for.
 */
const MAX_TREE_PATHS = 800;

/**
 * Never walked into.
 *
 * `node_modules` above all: it would turn a three-level walk into a hundred thousand paths, and it
 * contains a real `constructEvent` inside the Stripe package — a handler detector that finds the
 * library's own source has found nothing.
 */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel']);

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** What makes a file a Stripe webhook handler: it verifies a signature. */
const STRIPE_HANDLER = /\bwebhooks\s*\.\s*constructEvent\s*\(/;

/** Clerk's, which arrives through Svix — either the verification or the typed event. */
const CLERK_HANDLER = [/from\s+['"]svix['"]/, /\bWebhookEvent\b/, /new\s+Webhook\s*\(/];

const nothing = (reason: string): Detected => ({
  supported: false,
  reason,
  framework: null,
  stripe: null,
  auth: null,
  dataModel: null,
  testCommand: null,
  missing: [],
  tree: [],
  treeTruncatedBy: 0,
});

/** Repo-relative and always forward-slashed, so a path reads the same on every platform. */
function toPosix(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

async function walk(root: string, depth = TREE_DEPTH): Promise<string[]> {
  const found: string[] = [];

  async function visit(dir: string, remaining: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch {
      // An unreadable directory is not a reason to fail the whole command.
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || remaining <= 0) continue;
        await visit(full, remaining - 1);
      } else if (entry.isFile()) {
        found.push(toPosix(root, full));
      }
    }
  }

  await visit(root, depth);

  return found.sort();
}

/** Whether any of these directories exists under the root. */
async function hasDirectory(root: string, candidates: string[]): Promise<boolean> {
  for (const candidate of candidates) {
    try {
      if ((await stat(join(root, candidate))).isDirectory()) return true;
    } catch {
      // Not there.
    }
  }

  return false;
}

/** Reads a file, or null. A file that cannot be read is a file that is not there, for our purposes. */
async function read(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

async function firstMatching(
  root: string,
  candidates: string[],
  matches: (source: string) => boolean,
): Promise<string | null> {
  for (const path of candidates) {
    const source = await read(root, path);
    if (source !== null && matches(source)) return path;
  }

  return null;
}

/** The first `model X` in a Prisma schema whose name or fields say it is the user. */
function prismaUserModel(schema: string): string | null {
  const models = [...schema.matchAll(/^\s*model\s+(\w+)\s*\{([^}]*)\}/gm)];
  const named = models.find(m => /^(user|users|account|accounts|member|members|profile)$/i.test(m[1]!));
  if (named) return named[1]!;

  // Fall back to whichever model carries an email — which is the field this whole product needs.
  const withEmail = models.find(m => /\bemail\b/i.test(m[2]!));

  return withEmail?.[1] ?? null;
}

/** The first `pgTable('name', …)` that looks like people rather than orders. */
function drizzleUserTable(schema: string): string | null {
  const tables = [...schema.matchAll(/(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{([^}]*)\}/g)];
  const named = tables.find(t => /^(users?|accounts?|members?|profiles?)$/i.test(t[1]!));
  if (named) return named[1]!;

  const withEmail = tables.find(t => /\bemail\b/i.test(t[2]!));

  return withEmail?.[1] ?? null;
}

/**
 * Workspaces under this root that `init` WOULD understand.
 *
 * A monorepo root has no dependencies of its own — they live in the workspaces — so the ordinary
 * answer there is "this project has neither Next.js nor Stripe", which is simply false about a
 * Next + Stripe monorepo. Measured against a real Turborepo, which is the shape a team likely to
 * run this actually has.
 *
 * It names the candidates and stops. Picking one for somebody is the same mistake as picking their
 * project for them.
 */
async function supportedWorkspaces(root: string, patterns: string[]): Promise<string[]> {
  const parents = [...new Set(patterns.map(pattern => pattern.replace(/\/\*+$/, '')))];
  const candidates: string[] = [];

  for (const parent of parents) {
    let entries;
    try {
      entries = await readdir(join(root, parent), {withFileTypes: true});
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = `${parent}/${entry.name}`;
      const manifest = await read(root, `${path}/package.json`);
      if (!manifest) continue;

      try {
        const {dependencies, devDependencies} = JSON.parse(manifest) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = {...dependencies, ...devDependencies};
        if ('next' in deps && 'stripe' in deps) candidates.push(path);
      } catch {
        // A workspace with an unreadable manifest is one we cannot recommend; it is not an error
        // for the root.
      }
    }
  }

  return candidates;
}

export async function detect(root: string): Promise<Detected> {
  const manifest = await read(root, 'package.json');
  if (manifest === null) {
    return nothing('No package.json here. Run `bitelio init` from the root of your project.');
  }

  let parsed: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    workspaces?: string[] | {packages?: string[]};
  };
  try {
    parsed = JSON.parse(manifest);
  } catch {
    // A merge conflict or a half-saved file. "Unexpected token }" is not an answer.
    return nothing('This package.json is not valid JSON, so nothing here can be read.');
  }

  const deps = {...parsed.dependencies, ...parsed.devDependencies};
  const hasNext = 'next' in deps;
  const hasStripe = 'stripe' in deps;

  if (!hasNext || !hasStripe) {
    const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : (parsed.workspaces?.packages ?? []);
    const inside = workspaces.length > 0 ? await supportedWorkspaces(root, workspaces) : [];

    if (inside.length > 0) {
      return nothing(
        `This is a workspace root, so its dependencies live one level down. ` +
          `Run \`bitelio init\` from ${inside.map(path => `\`${path}\``).join(' or ')}.`,
      );
    }

    if (workspaces.length > 0) {
      // A workspace root where no single package is both. Saying "this project has neither" would
      // be the wrong sentence about a repository that plainly has both, just not together.
      return nothing(
        `This is a workspace root and no workspace in it has both Next.js and Stripe. ` +
          `\`init\` reads one application at a time; run it from the one that handles your payments.`,
      );
    }

    // Named rather than generic, because the developer should be able to disagree with it: they may
    // have Stripe behind a wrapper, or an app somewhere this does not look.
    const found = [hasNext && 'Next.js', hasStripe && 'Stripe'].filter(Boolean).join(' and ') || 'neither';

    return nothing(
      `\`init\` reads Next.js and Stripe, and this project has ${found}. ` +
        `It stops here rather than guess at a stack it does not understand.`,
    );
  }

  const everything = await walk(root);
  const tree = everything.slice(0, MAX_TREE_PATHS);
  const missing: string[] = [];

  // Asked of the filesystem rather than inferred from the file list: the directory existing is the
  // signal, and a router directory that happens to be empty still says which router this app uses.
  //
  // `src/app` and `src/pages` are checked too — a layout `create-next-app` offers, and the one the
  // real dashboard in this monorepo uses. Looking only at the top level answered `router: null` for
  // a perfectly ordinary Next application.
  const [hasApp, hasPages] = await Promise.all([
    hasDirectory(root, ['app', 'src/app']),
    hasDirectory(root, ['pages', 'src/pages']),
  ]);
  const framework: Framework = {
    name: 'next',
    version: deps.next?.replace(/^[^\d]*/, '') || null,
    // Both is possible during a migration; `app` is where new routes go, so it wins.
    router: hasApp ? 'app' : hasPages ? 'pages' : null,
  };

  // Searched over everything, not the trimmed tree: the handler must be findable even in a
  // repository big enough to trim.
  const sources = everything.filter(path => SOURCE_FILE.test(path));

  const stripeHandler = await firstMatching(root, sources, source => STRIPE_HANDLER.test(source));
  if (!stripeHandler) {
    // Installed and unused is a real state, and claiming a handler that is not there produces a
    // patch that edits a file which does not exist.
    missing.push('stripe-handler');
  }

  const authHandler =
    'clerk' in deps || '@clerk/nextjs' in deps
      ? await firstMatching(root, sources, source => CLERK_HANDLER.some(pattern => pattern.test(source)))
      : null;
  if (!authHandler) missing.push('auth');

  const prismaSchema = everything.find(path => path.endsWith('schema.prisma'));
  const drizzleSchema = everything.find(path => /(^|\/)(db|drizzle|lib)\/schema\.(ts|js)$/.test(path));

  let dataModel: DataModel | null = null;
  if (prismaSchema) {
    const schema = (await read(root, prismaSchema)) ?? '';
    dataModel = {kind: 'prisma', file: prismaSchema, userModel: prismaUserModel(schema)};
  } else if (drizzleSchema) {
    const schema = (await read(root, drizzleSchema)) ?? '';
    dataModel = {kind: 'drizzle', file: drizzleSchema, userModel: drizzleUserTable(schema)};
  } else {
    missing.push('data-model');
  }

  // Taken as written, never invented. `init` verifies its own patch by running this, and a made-up
  // command runs something arbitrary in somebody else's repository.
  const testCommand = parsed.scripts?.test ?? null;
  if (!testCommand) missing.push('test-command');

  return {
    supported: true,
    reason: null,
    framework,
    stripe: stripeHandler ? {handler: stripeHandler} : null,
    auth: authHandler ? {provider: 'clerk', handler: authHandler} : null,
    dataModel,
    testCommand,
    missing,
    tree,
    treeTruncatedBy: everything.length - tree.length,
  };
}
