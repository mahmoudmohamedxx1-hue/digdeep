import type { MetadataRoute } from "next";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** P0-2: sitemap — static surfaces + every shared (public) report page. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://digdeepx.vercel.app";
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "daily", priority: 1 },
    { url: `${base}/gallery`, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/benchmark`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/api-docs`, changeFrequency: "monthly", priority: 0.7 },
  ];
  let shared: MetadataRoute.Sitemap = [];
  try {
    const snaps = await db.sharedReport.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { id: true, createdAt: true },
    });
    shared = snaps.map((s) => ({
      url: `${base}/s/${s.id}`,
      lastModified: s.createdAt,
      changeFrequency: "monthly",
      priority: 0.8,
    }));
  } catch {
    shared = [];
  }
  return [...staticRoutes, ...shared];
}
