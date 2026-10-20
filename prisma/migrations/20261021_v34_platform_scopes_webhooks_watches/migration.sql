-- v3.4: platform layer — per-key scopes + quotas, webhooks, watched research.
-- FULLY IDEMPOTENT (same discipline as the v3.3 fix): IF NOT EXISTS on every
-- column/table/index, pg_constraint-guarded DO-blocks for every FK. Safe
-- against fresh, partially-evolved, and fully-evolved databases. See
-- scripts/test-migration.sh — States A–D all end at zero drift.

-- ── ApiKey: scopes + monthly quota ──────────────────────────────────────────
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "scopes" TEXT[] NOT NULL DEFAULT ARRAY['research:read','research:write','webhooks','watches']::TEXT[];
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "monthlyLimit" INTEGER;

-- ── ResearchJob: key attribution + watch linkage ────────────────────────────
ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "apiKeyId" TEXT;
ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "watchId" TEXT;

-- ── Webhook ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Webhook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] NOT NULL DEFAULT ARRAY['run.completed']::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- ── WebhookDelivery ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "jobId" TEXT,
    "event" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "status" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- ── Watch ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Watch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "preset" TEXT NOT NULL DEFAULT 'standard',
    "domain" TEXT NOT NULL DEFAULT 'general',
    "language" TEXT NOT NULL DEFAULT 'English',
    "court" BOOLEAN NOT NULL DEFAULT false,
    "cadenceDays" INTEGER NOT NULL DEFAULT 7,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRunId" TEXT,
    "lastVerdict" TEXT,
    "lastSignature" TEXT,
    "lastChangedAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watch_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "ResearchJob_apiKeyId_createdAt_idx" ON "ResearchJob"("apiKeyId", "createdAt");
CREATE INDEX IF NOT EXISTS "ResearchJob_watchId_idx" ON "ResearchJob"("watchId");
CREATE INDEX IF NOT EXISTS "Webhook_userId_idx" ON "Webhook"("userId");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt");
CREATE INDEX IF NOT EXISTS "Watch_active_nextRunAt_idx" ON "Watch"("active", "nextRunAt");

-- ── Foreign keys (no IF NOT EXISTS for constraints — guarded via pg_constraint) ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ResearchJob_apiKeyId_fkey') THEN
    ALTER TABLE "ResearchJob" ADD CONSTRAINT "ResearchJob_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ResearchJob_watchId_fkey') THEN
    ALTER TABLE "ResearchJob" ADD CONSTRAINT "ResearchJob_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "Watch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Webhook_userId_fkey') THEN
    ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WebhookDelivery_webhookId_fkey') THEN
    ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Watch_userId_fkey') THEN
    ALTER TABLE "Watch" ADD CONSTRAINT "Watch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
