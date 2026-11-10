# QueueLab roadmap

Copied from the implementation plan. Checked items work in this repository.

## Week 1 — Foundation

- [x] Initialize pnpm monorepo and Angular/NestJS projects
- [x] Configure PostgreSQL and Redis with Docker Compose
- [x] Create Prisma schema and initial migration
- [x] Build Job CRUD endpoints and Swagger documentation
- [x] Create Angular shell, job list, and details page
- [x] Add seeded demo jobs and verify frontend-to-API integration

## Week 2 — Background processing

- [x] Create BullMQ queue producer and worker
- [x] Persist job progress, events, and results
- [x] Create the submit form and result details
- [x] Implement validated CSV file uploads
- [x] Implement streaming CSV validation and aggregation
- [x] Test successful and invalid CSV processing

The worker streams `uploads/{id}.csv`. The API may hold a file up to 10 MB while it writes it. The worker never reads that file into one string. Structural problems (empty file, missing columns, broken quotes, every row invalid) are permanent and are not retried. A row with a bad quantity is counted and excluded from the totals. The "fail at 34%" demonstration was removed because it failed on every attempt and could not show recovery.

## Week 3 — Real-time and reliability

- [x] Configure BullMQ attempts and exponential backoff
- [x] Publish a job notice after the PostgreSQL write and fan it out with Socket.IO
- [x] Refetch the REST ledger in Angular on each notice and on reconnect
- [x] Classify a one-attempt transient failure separately from a permanent CSV error
- [x] Add a manual retry that starts a new execution and preserves attempt history
- [x] Reconcile `PENDING_ENQUEUE` rows onto the same execution id
- [x] Let BullMQ rerun a stalled worker, then fail once the stall limit is reached
- [x] Store each execution's report on its own path and upsert one `JobResult`

## Week 4 — Production polish

- [x] Add authentication and owner-based authorization
- [ ] Write integration and browser end-to-end tests
- [x] Configure GitHub Actions CI
- [ ] Deploy frontend, API, worker, PostgreSQL, and Redis
- [ ] Record performance measurements and a demo video
- [ ] Finish the system diagram and architectural tradeoff notes

## Milestones

| Milestone | What must work | State |
| --- | --- | --- |
| M1: API connected | Seeded jobs appear in Angular from PostgreSQL | Done |
| M2: Processing | An uploaded CSV produces a real summary report | Done |
| M3: Reliability | Jobs can fail, retry, recover, and update the dashboard | Done. Live updates, manual retry, and crash recovery work |
| M4: Portfolio | Deployed app, automated tests, documentation, and demo | Authentication, owner checks, CI, and the Render blueprint are in place. The public services are not created yet |

## Engineering notes

- **Upload then enqueue.** The file is stored before the job row exists. The job points at `uploads/{uuid}.csv`. Reusing one upload for several jobs is allowed. Idempotency is per job id.
- **Why the API buffers and the worker streams.** Multipart parsing already has the body. Capping it at 10 MB keeps that buffer small. The worker opens the object as a stream and parses it with `csv-parse`. Progress uses the object size, which stays correct when a quoted field contains a newline.
- **One bucket, two processes.** Local development writes under `STORAGE_PATH`. Production sets `S3_BUCKET` and both the API and the worker use that bucket. A container restart does not delete an upload or a report. The local store still publishes a report with a temp file and a rename, so a crash cannot leave a partial file. An S3 put replaces the whole object.
- **Cents, not floats.** Amounts are summed as integer cents and divided at the end, so `10.555` and `2.25` do not drift.
- **Permanent versus retryable.** `PermanentCsvError` becomes BullMQ `UnrecoverableError`. A missing file is permanent. Other I/O errors are thrown so the attempt budget still applies.
- **One result row.** The worker writes `results/{jobId}/{executionId}.json` before the database commit, and only if that execution is still current. The commit upserts `JobResult` on `job_id`. A crash before the file leaves the next attempt to read the CSV again. A crash after the file and before the commit leaves that execution's file for the next attempt to overwrite. A crash after the commit returns immediately on the next run. An older execution never writes the newer execution's path.
- **Pending enqueue is claimed, not scanned twice.** The API reconciler selects executions older than `PENDING_ENQUEUE_MIN_AGE_MS` (15 seconds) and claims the job with `enqueue_claimed_at`. The loser of that update does nothing. A claim older than `RECONCILE_CLAIM_LEASE_MS` (20 seconds) can be taken again, including when the API dies after the claim and before Redis accepts the job. Redis is checked for the existing execution id before a second add. The row becomes `QUEUED` only after that check succeeds.
- **Stalled workers stay inside BullMQ.** Lock duration and the stall check default to 30 seconds. One stall reruns the execution. `BULLMQ_MAX_STALLED_COUNT` defaults to 1, so the next stall fails it and the ledger copies that failure. A queue record that has vanished, or a completion whose result is already stored, is repaired by the same reconciler. It does not invent a second execution.
- **Job, execution, attempt.** `jobId` is the logical row. `executionId` is one manual run and the BullMQ job id, because a failed queue id cannot be added again. `attempt` is BullMQ's automatic try inside that execution. A conditional update claims a failed job, so two retry requests create one execution. The worker upserts `JobResult` only while its execution is still current.
- **Transient means the next attempt can succeed.** `demoFailure: transient` throws on attempt 1 only. A broken CSV is `UnrecoverableError` and stops at attempt 1. `exhaust-first-execution` fails every automatic attempt of execution 1 so a manual retry can be tested after the attempt budget is gone.
- **The token is the boundary.** The Angular guard only chooses which page to show. Nest checks the OpenID ID token on every job, upload, metric, and download, and the socket handshake uses that same check. Verification requires the issuer, the client id as audience, the signature, and `exp`. The callback also checks `state`, PKCE, and `nonce`. A job room is joined only when `user_id` matches. The ledger room is `user:{id}`, so one visitor does not receive another visitor's notices. The local issuer exists only while `OIDC_ISSUER` is empty, and only for a loopback `Host`. Production also requires https origins and a cookie secret of at least 16 characters, and it sets the cookie `Secure`. Cookie mutations need `X-QueueLab-Request` plus an `Origin` matching `WEB_ORIGIN`. `SameSite` stays `Lax` because the provider returns with a top-level navigation.
- **Sockets notify, PostgreSQL decides.** BullMQ QueueEvents can fire before the ledger write is visible. The worker publishes only after that write commits. The browser throws the notice away and rereads `/jobs/:id`. Reconnect joins the room again and rereads, which covers a laptop that slept through the completion. While the socket is down, the page falls back to a two-second poll. One API process owns the Socket.IO rooms; a second API instance would need a Socket.IO Redis adapter.

