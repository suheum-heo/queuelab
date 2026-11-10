-- A reconciler claims a row by writing this timestamp.
-- Another process skips the row until the lease is older than its cutoff.
ALTER TABLE "jobs" ADD COLUMN "enqueue_claimed_at" TIMESTAMP(3);

-- Pending executions are selected by status and age.
CREATE INDEX "job_executions_status_created_at_idx" ON "job_executions"("status", "created_at");
