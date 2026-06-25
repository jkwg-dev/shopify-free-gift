/** @type {import('next').NextConfig} */
const nextConfig = {
  // Type/lint checks run via the workspace pipeline (tsc + eslint), not as part of `next build`.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
