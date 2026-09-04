#!/usr/bin/env node
import {run} from './main.js';
import {paint, write} from './prompt.js';

/**
 * The bin, and nothing else.
 *
 * The logic lives in `main.ts` so that importing it from a test does not execute a program. The
 * obvious alternative — one file guarded by `import.meta.url === file://${process.argv[1]}` — was
 * written first and silently did nothing when installed: under `npx`, `argv[1]` is the symlink in
 * `node_modules/.bin`, never the real path, so the guard is false exactly where it matters. It
 * passed from source and printed nothing from a packed tarball.
 */
run(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch((error: Error) => {
    write(paint.red({input: process.stdin, output: process.stdout}, error.message));
    process.exit(1);
  });
