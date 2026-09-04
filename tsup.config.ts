import {defineConfig} from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // The `bitelio` bin. It gets a CJS twin like everything else here — tsup applies `format`
    // per build, not per entry — which is 2.8 kB of tarball nothing executes. Not worth a second
    // build config; noted so the next reader does not go looking for who runs dist/cli.cjs.
    cli: 'src/cli/index.ts',
  },
  // Both, because a mail SDK gets installed into servers that have not migrated and never will.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Without this, esbuild renames `BitelioError` to `_BitelioError` and every stack trace a user
  // reads starts with an underscore. `instanceof` and `error.name` are both fine either way — the
  // constructor sets `name` explicitly — but the mangled class name is the first thing somebody
  // debugging sees, and it looks like a bug in our client.
  keepNames: true,
  // Nothing to bundle: the package has no runtime dependencies, deliberately. A client that drags
  // a dependency tree onto somebody else's production server shows up in their first audit.
  treeshake: true,
});
