/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // instrumentation.ts registers the process-level guards (unhandled
    // rejections logged instead of killing the server, a memory line every
    // ten minutes) — see that file for why a self-hosted process needs them.
    instrumentationHook: true,
  },
};

export default nextConfig;
