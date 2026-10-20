import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* pdfkit ships standard-font AFM data behind `#standard-fonts` subpath
     imports — bundling breaks them (Cannot find module '#standard-fonts/
     Helvetica' → PDF export 500s). Keeping it external lets the standalone
     runtime resolve its own imports + data files. */
  serverExternalPackages: ["pdfkit"],
  /* Next's tracer copies only part of pdfkit (misses js/pdfkit.js and
     js/standard-fonts/*.cjs behind `#standard-fonts` subpath imports) —
     force-include the whole package for the export route. Applies to local
     standalone AND Vercel's packaging. */
  outputFileTracingIncludes: {
    "/api/research/**/*": ["./node_modules/pdfkit/**/*"],
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // hide the Next.js dev badge — it covered the Dark mode toggle
  devIndicators: false,
};

export default nextConfig;
