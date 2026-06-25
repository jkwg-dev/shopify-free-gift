/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages are consumed as TypeScript source (their exports point at src/*.ts), so Next
  // must transpile them — it ignores node_modules by default and would otherwise fail on their TS.
  transpilePackages: ['@free-gift-engine/core', '@free-gift-engine/shopify'],
  // Type/lint checks run via the workspace pipeline (tsc + eslint), not as part of `next build`.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
