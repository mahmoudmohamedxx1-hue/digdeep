"use client";

import { RefreshCw } from "lucide-react";

export function RetryButton() {
  return (
    <button
      onClick={() => window.location.reload()}
      className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent"
    >
      <RefreshCw className="h-4 w-4" /> Try again
    </button>
  );
}
