import { WifiOff, BookOpen } from "lucide-react";
import Link from "next/link";
import { RetryButton } from "./retry-button";

export const metadata = {
  title: "Offline — but your research is safe",
};

/** P2-4: the offline fallback page — threads live in IndexedDB, so local
 *  history survives any connection state. */
export default function OfflinePage() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10">
        <WifiOff className="h-7 w-7 text-amber-500" />
      </div>
      <h1 className="mt-5 font-serif text-2xl font-semibold tracking-tight">You are offline — but nothing is lost</h1>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">
        DigDeep is offline-first: every thread you have opened lives in this browser. Your library, reports, and
        verdicts are readable right now; new runs and live updates resume the moment you reconnect.
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/library"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          <BookOpen className="h-4 w-4" /> Open my library
        </Link>
        <RetryButton />
      </div>
    </div>
  );
}
