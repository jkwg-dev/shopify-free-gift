/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages are consumed as TypeScript source (their exports point at src/*.ts), so Next
  // must transpile them — it ignores node_modules by default and would otherwise fail on their TS.
  transpilePackages: ['@free-gift-engine/core', '@free-gift-engine/shopify'],
  // The codebase uses NodeNext-style `.js` import specifiers that point at `.ts` source (route
  // handlers and the workspace packages' internal imports). webpack must map `.js` -> `.ts` to
  // resolve them, otherwise `next build` fails with "Module not found: ... .js".
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
  // Type/lint checks run via the workspace pipeline (tsc + eslint), not as part of `next build`.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
