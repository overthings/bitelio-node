import {defineConfig} from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Both, because a mail SDK gets installed into servers that have not migrated and never will.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Nothing to bundle: the package has no runtime dependencies, deliberately. A client that drags
  // a dependency tree onto somebody else's production server shows up in their first audit.
  treeshake: true,
});
