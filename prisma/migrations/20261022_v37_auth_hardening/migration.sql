-- v3.7 auth hardening: durable per-account attempt tracking. Powers the
-- per-email lockouts (login + OTP verify) and the per-email send cooldown —
-- limits that must hold across serverless instance recycling, where the
-- in-memory rate limiter resets on every cold start.
-- FULLY IDEMPOTENT (repo convention): a database evolved by `prisma db push`
-- already carries the full schema.prisma — including this table — so a bare
-- CREATE would fail the deploy with "relation already exists" (the v3.3
-- incident class). IF NOT EXISTS keeps every database state deployable.
CREATE TABLE IF NOT EXISTS "AuthAttempt" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAttempt_pkey" PRIMARY KEY ("id")
);

-- Every lookup is windowed (kind, email, createdAt > since) — one index
-- serves them all; the table stays tiny (24h retention, swept on write).
CREATE INDEX IF NOT EXISTS "AuthAttempt_kind_email_createdAt_idx" ON "AuthAttempt"("kind", "email", "createdAt");
