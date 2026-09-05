import type {Extract, ExtractFile} from './extract.js';
import {undetectableWithout} from './extract.js';
import {isInteractive, menu, paint, write, type Io} from './prompt.js';

/**
 * The screen that makes the upload the developer's decision rather than the tool's.
 *
 * It shows the RESULT, not the intention: the actual files, their actual sizes, and how many values
 * the secret filter replaced in each. Any of them can be opened and read exactly as it will be sent
 * — already redacted, so the preview and the wire are the same bytes. A screen that previews one
 * thing and uploads another would be worse than no screen.
 *
 * Excluding a file says what it costs. "Excluded" on its own reads as "made no difference", and for
 * the Stripe handler it is the difference between detecting three lifecycle events and detecting
 * none of them.
 */

/**
 * What the repository did not turn out to have, and what that costs.
 *
 * Shown next to what WILL be uploaded, for the same reason exclusions are: an analysis missing its
 * Stripe handler cannot find `subscription_started`, and a listing that only says what it found
 * reads as though it found everything. Measured against a real Next app with no webhook handler —
 * the screen offered two files and said nothing about the three events that were now out of reach.
 */
function whatIsMissing(io: Io, missing: string[]): string[] {
  const lines: string[] = [];

  if (missing.includes('stripe-handler')) {
    lines.push(
      paint.yellow(io, '  No Stripe webhook handler found — subscription_started, payment_failed and cancelled cannot be detected.'),
    );
  }
  if (missing.includes('auth')) {
    lines.push(paint.yellow(io, '  No signup webhook found — signup and email_verification cannot be detected.'));
  }
  if (missing.includes('data-model')) {
    lines.push(paint.dim(io, '  No Prisma or Drizzle schema found — events will not be typed against your user model.'));
  }
  if (missing.includes('test-command')) {
    lines.push(paint.dim(io, '  No `test` script in package.json — the patch cannot be checked before the pull request.'));
  }

  return lines;
}

const kb = (text: string): string => {
  const size = Buffer.byteLength(text, 'utf8');

  return size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`;
};

/**
 * One row of the listing: path, size, and whatever is worth saying about it.
 *
 * Padded BEFORE it is coloured. `padEnd` counts the ANSI escapes as characters, so colouring first
 * makes a styled row several characters shorter on screen than an unstyled one — which is exactly
 * how the excluded row came out misaligned from every other line in the table.
 */
function row(io: Io, file: ExtractFile, excluded: boolean): string {
  const notes = [file.why];
  if (file.redactions > 0) notes.push(paint.yellow(io, `${file.redactions} secrets redacted`));
  if (file.truncated) notes.push(paint.yellow(io, 'truncated to fit'));

  const label = excluded ? `${file.path} (excluded)` : file.path;
  const padded = label.padEnd(46);

  return `  ${excluded ? paint.dim(io, padded) : padded} ${kb(file.content).padStart(6)}   ${paint.dim(io, notes.join(' · '))}`;
}

export interface ConsentResult {
  /** What the developer agreed to send. Empty when they quit. */
  files: ExtractFile[];
  approved: boolean;
}

/**
 * Show the extract and wait for a decision.
 *
 * In a non-interactive shell it prints the listing and refuses. `init` uploads a developer's source
 * to a model, and consent that nobody gave is not consent — a scripted run has `--dry-run` to see
 * the listing and `--yes` for everything else, but never this.
 */
export async function askConsent(extract: Extract, io: Io): Promise<ConsentResult> {
  const excluded = new Set<string>();

  for (;;) {
    const keeping = extract.files.filter(file => !excluded.has(file.path));
    const total = keeping.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);

    write('', io);
    // "Ready to upload", not "Uploading". Nothing has left the machine at the moment this is on
    // screen, and the whole point of the screen is that it might not.
    write(`  Ready to upload ${keeping.length} files (${kb('x'.repeat(total))}) for analysis:`, io);
    write('', io);
    for (const file of extract.files) write(row(io, file, excluded.has(file.path)), io);

    if (extract.dropped.length > 0) {
      // Never silent. An extract missing half its input that reads as complete produces an analysis
      // nobody can account for.
      write('', io);
      write(paint.yellow(io, `  Too large — left out: ${extract.dropped.join(', ')}`), io);
    }

    const absent = whatIsMissing(io, extract.detected.missing);
    if (absent.length > 0) {
      write('', io);
      for (const line of absent) write(line, io);
    }

    const lost = [...excluded].flatMap(path => undetectableWithout(path, extract.detected));
    if (lost.length > 0) {
      write('', io);
      write(paint.yellow(io, `  Without those, these cannot be detected: ${lost.join(', ')}`), io);
    }

    write('', io);

    if (!isInteractive(io)) {
      // Printing the listing and then uploading anyway would make the screen decoration.
      throw new Error('Uploading your code needs a yes from a person. Run this in a terminal, or use --dry-run.');
    }

    const choice = await menu(
      '  What now?',
      [
        {key: 'v', label: 'view one', value: 'view' as const},
        {key: 'x', label: 'exclude one', value: 'exclude' as const},
        {key: 'u', label: 'upload', value: 'upload' as const},
        {key: 'q', label: 'quit', value: 'quit' as const},
      ],
      io,
    );

    if (choice === 'quit') return {files: [], approved: false};
    if (choice === 'upload') return {files: keeping, approved: true};

    const which = await menu(
      choice === 'view' ? '  Which one?' : '  Exclude which one?',
      extract.files.map((file, index) => ({key: String(index + 1), label: file.path, value: file.path})),
      io,
    );

    if (choice === 'exclude') {
      // Toggling, because excluding by mistake should not need a restart.
      if (excluded.has(which)) excluded.delete(which);
      else excluded.add(which);
      continue;
    }

    const file = extract.files.find(f => f.path === which)!;
    write('', io);
    write(paint.dim(io, `  ── ${file.path}, exactly as it would be sent ──`), io);
    write(file.content, io);
    write(paint.dim(io, '  ──'), io);
  }
}

/**
 * `--dry-run`: print the listing and stop.
 *
 * The same rows the consent screen shows, so what a nervous developer inspects beforehand is what
 * they will be asked to approve. It also makes this release useful on its own — the tool can be
 * pointed at a repository and asked what it would take, before anyone trusts it with anything.
 */
export function printDryRun(extract: Extract, io: Io): void {
  write('', io);
  write(`  Would upload ${extract.files.length} files (${kb('x'.repeat(extract.totalBytes))}):`, io);
  write('', io);
  for (const file of extract.files) write(row(io, file, false), io);

  if (extract.dropped.length > 0) {
    write('', io);
    write(paint.yellow(io, `  Too large — would leave out: ${extract.dropped.join(', ')}`), io);
  }

  const absent = whatIsMissing(io, extract.detected.missing);
  if (absent.length > 0) {
    write('', io);
    for (const line of absent) write(line, io);
  }

  write('', io);
  write(paint.dim(io, '  Nothing was uploaded. Drop --dry-run to go ahead.'), io);
}
