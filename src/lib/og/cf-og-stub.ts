/**
 * CF_PROFILE stub for next/og.
 *
 * On the Cloudflare Workers FREE plan the worker script limit is 3 MiB
 * gzipped — next/og's satori + resvg.wasm + yoga.wasm + Noto font weigh
 * ~700 KiB gzipped on their own and push the bundle over. Under
 * CF_PROFILE=1 the webpack build aliases "next/og" to THIS module, so the
 * wasm never enters the bundle, and /api/og/[id] serves its SVG card
 * variant instead (platforms that demand raster og:images show a text
 * card; browsers/Discord/Telegram render the SVG fine).
 *
 * This class is never constructed on the CF profile (the route branches
 * before it) — it exists so the import stays valid for both profiles.
 */
export class ImageResponse extends Response {
  constructor(_element: unknown, _options?: { width?: number; height?: number }) {
    super(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#04110f"/></svg>`,
      { headers: { "Content-Type": "image/svg+xml" } },
    );
  }
}
