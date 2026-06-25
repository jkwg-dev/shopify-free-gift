// Bundle the storefront controller (TS, importing the pure core reconciler) into the theme
// extension's served asset: ../../extensions/theme/assets/free-gift.js. This package holds the
// source/build; extensions/theme is a PURE theme-extension dir (only assets/blocks/locales +
// shopify.extension.toml — the CLI rejects anything else, e.g. .turbo/node_modules/src). The
// js-to-ts plugin resolves the codebase's NodeNext `.js` specifiers to their `.ts` source.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const jsToTs = {
  name: 'js-to-ts',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith('.')) {
        return null; // bare/package imports: let esbuild resolve normally
      }
      const ts = resolve(args.resolveDir, args.path).replace(/\.js$/, '.ts');
      return existsSync(ts) ? { path: ts } : null;
    });
  },
};

await build({
  entryPoints: [resolve(import.meta.dirname, 'src/storefront.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2019',
  outfile: resolve(import.meta.dirname, '../../extensions/theme/assets/free-gift.js'),
  legalComments: 'none',
  plugins: [jsToTs],
});

console.log('Built extensions/theme/assets/free-gift.js');
