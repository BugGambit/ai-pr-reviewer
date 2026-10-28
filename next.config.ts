import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "playwright"],
  eslint: { ignoreDuringBuilds: true },
  // Long-running Claude reviews / screenshot captures are tracked as jobs, but
  // keep the proxy generous anyway.
  experimental: { proxyTimeout: 600_000 },
};

export default nextConfig;
