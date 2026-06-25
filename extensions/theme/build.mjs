// Bundle the storefront controller (TS, importing the pure core reconciler) into a single browser
// asset the theme app extension serves: assets/free-gift.js. The js-to-ts plugin resolves the
// codebase's NodeNext-style `.js` import specifiers to their `.ts` source (core + theme), the same
// gap next.config handles for the admin app.
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
  outfile: resolve(import.meta.dirname, 'assets/free-gift.js'),
  legalComments: 'none',
  plugins: [jsToTs],
});

console.log('Built assets/free-gift.js');
