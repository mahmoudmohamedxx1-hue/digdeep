-- v3.3: accounts, workspaces, API keys, domain packs.
-- FULLY IDEMPOTENT by design: production's ResearchJob already carries the
-- v3.0-v3.2 columns below (applied via db push during development, not via a
-- migration file), so a plain ADD COLUMN would fail the whole deploy with
-- "column already exists". IF NOT EXISTS / DO-blocks make this safe against
-- every database state: fresh, partially evolved, or fully evolved.

-- AlterTable (v3.0-v3.2 columns included defensively — no-op where they exist)
ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "checkpoint" TEXT;
ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "court" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "domain" TEXT NOT NULL DEFAULT 'general';
ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);
ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "sliceN" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "userId" TEXT;
ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "workspaceId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_inviteCode_key" ON "Workspace"("inviteCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Workspace_createdAt_idx" ON "Workspace"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchJob_userId_updatedAt_idx" ON "ResearchJob"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchJob_workspaceId_updatedAt_idx" ON "ResearchJob"("workspaceId", "updatedAt");

-- AddForeignKey (no IF NOT EXISTS for constraints — guarded via pg_constraint)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ResearchJob_userId_fkey') THEN
    ALTER TABLE "ResearchJob" ADD CONSTRAINT "ResearchJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ResearchJob_workspaceId_fkey') THEN
    ALTER TABLE "ResearchJob" ADD CONSTRAINT "ResearchJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Session_userId_fkey') THEN
    ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Workspace_ownerId_fkey') THEN
    ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceMember_workspaceId_fkey') THEN
    ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceMember_userId_fkey') THEN
    ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApiKey_userId_fkey') THEN
    ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
