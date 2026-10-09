-- CreateTable
CREATE TABLE "ResearchJob" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "threadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT NOT NULL DEFAULT 'Initializing',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "preset" TEXT NOT NULL DEFAULT 'standard',
    "mode" TEXT NOT NULL DEFAULT 'research',
    "language" TEXT NOT NULL DEFAULT 'English',
    "modelPref" TEXT NOT NULL DEFAULT 'auto',
    "breadth" INTEGER NOT NULL DEFAULT 3,
    "depth" INTEGER NOT NULL DEFAULT 2,
    "maxSources" INTEGER NOT NULL DEFAULT 18,
    "maxMinutes" INTEGER NOT NULL DEFAULT 30,
    "reportMd" TEXT,
    "plan" TEXT,
    "stats" TEXT,
    "docs" TEXT,
    "error" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "model" TEXT,
    "meta" TEXT,
    "level" TEXT NOT NULL DEFAULT 'normal',

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snippet" TEXT,
    "engine" TEXT NOT NULL,
    "words" INTEGER NOT NULL DEFAULT 0,
    "quality" INTEGER NOT NULL DEFAULT 0,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "sectionTitle" TEXT,
    "round" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchSection" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "findings" TEXT,
    "draftMd" TEXT,
    "queries" TEXT,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "ResearchJob_status_updatedAt_idx" ON "ResearchJob"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityEvent_jobId_seq_key" ON "ActivityEvent"("jobId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Source_jobId_url_key" ON "Source"("jobId", "url");

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchSection" ADD CONSTRAINT "ResearchSection_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ResearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
