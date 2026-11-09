-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "execution_number" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "jobs" ADD COLUMN "current_execution_id" UUID;

-- CreateTable
CREATE TABLE "job_executions" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING_ENQUEUE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_executions_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "job_results" ADD COLUMN "execution_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "jobs_current_execution_id_key" ON "jobs"("current_execution_id");

-- CreateIndex
CREATE INDEX "job_executions_job_id_created_at_idx" ON "job_executions"("job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_executions_job_id_number_key" ON "job_executions"("job_id", "number");

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill one execution for jobs that were actually enqueued.
-- Sample rows stay at execution 0 because they were never sent to BullMQ.
INSERT INTO "job_executions" (
    "id",
    "job_id",
    "number",
    "status",
    "attempts",
    "error_message",
    "started_at",
    "finished_at",
    "created_at"
)
SELECT
    gen_random_uuid(),
    "id",
    1,
    "status",
    "attempts",
    "error_message",
    "started_at",
    "finished_at",
    "created_at"
FROM "jobs"
WHERE COALESCE("options"->>'seeded', 'false') <> 'true';

UPDATE "jobs" AS job
SET
    "execution_number" = 1,
    "current_execution_id" = execution."id"
FROM "job_executions" AS execution
WHERE execution."job_id" = job."id"
  AND execution."number" = 1;

UPDATE "job_results" AS result
SET "execution_id" = job."current_execution_id"
FROM "jobs" AS job
WHERE result."job_id" = job."id"
  AND job."current_execution_id" IS NOT NULL;
