-- CreateTable
CREATE TABLE "SharedReport" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "threadId" TEXT,
    "query" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'research',
    "language" TEXT NOT NULL DEFAULT 'English',
    "preset" TEXT NOT NULL DEFAULT 'standard',
    "reportMd" TEXT NOT NULL,
    "stats" TEXT,
    "sources" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SharedReport_jobId_key" ON "SharedReport"("jobId");

-- CreateIndex
CREATE INDEX "SharedReport_createdAt_idx" ON "SharedReport"("createdAt");
