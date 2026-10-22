import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  /* v3.7 baseline security headers — applied to every route (pages, API,
     static). HSTS pins HTTPS for repeat visitors; nosniff stops MIME-type
     confusion on served files; the rest lock framing, referrer leakage and
     powerful APIs to same-origin needs. og-card images are fetched as plain
     images by social embedders — unaffected. */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
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
  /* CF_PROFILE (Cloudflare Workers free plan): alias next/og to a lightweight
     stub — satori + resvg.wasm + yoga.wasm + Noto (~700 KiB gzipped) would
     push the worker over the free 3 MiB limit. The og route serves its SVG
     card variant on this profile (see src/lib/og/cf-og-stub.ts). Vercel and
     local builds are untouched — full PNG og:images everywhere else. */
  webpack: (config) => {
    if (process.env.CF_PROFILE === "1") {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "next/og": path.resolve(__dirname, "src/lib/og/cf-og-stub.ts"),
      };
    }
    return config;
  },
};

export default nextConfig;
