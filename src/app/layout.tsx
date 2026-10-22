import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "next-themes";
import { Shell } from "@/components/app/shell";
import { RegisterSW } from "@/components/app/register-sw";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://digdeepx.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "DigDeep — the research tool that puts its own answer on trial",
    template: "%s — DigDeep",
  },
  description:
    "DigDeep reads the whole web, puts every claim on trial with a prosecutor, a defense, and a jury of 12, audits every citation against its source passage, and can withhold its verdict when the evidence is thin. Free — no LLM keys needed; a free email account gets you researching.",
  keywords: [
    "digdeep",
    "deep research",
    "AI research",
    "verified research",
    "citation audit",
    "adversarial verification",
    "research report",
    "perplexity alternative",
    "free deep research",
    "court mode AI",
  ],
  authors: [{ name: "DigDeep Engineering" }],
  openGraph: {
    type: "website",
    siteName: "DigDeep",
    title: "DigDeep — the research tool that puts its own answer on trial",
    description:
      "Every claim checked. Every citation audited. A prosecutor, a defense, and 12 jurors cross-examine the answer before it reaches you. Free and keyless.",
    url: "/",
    images: [{ url: "/api/og-card", width: 1200, height: 630, alt: "DigDeep — deep research that shows its work" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "DigDeep — deep research that shows its work",
    description: "Every claim checked. Every citation audited. Free and keyless.",
    images: ["/api/og-card"],
  },
  robots: { index: true, follow: true },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "DigDeep",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <RegisterSW />
          <Shell>{children}</Shell>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
