import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // hide the Next.js dev badge — it covered the Dark mode toggle
  devIndicators: false,
};

export default nextConfig;
