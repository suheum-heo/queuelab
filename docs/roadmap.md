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

The worker streams `storage/uploads/{id}.csv`. The API may hold a file up to 10 MB while it writes it. The worker never reads that file into one string. Structural problems (empty file, missing columns, broken quotes, every row invalid) are permanent and are not retried. A row with a bad quantity is counted and excluded from the totals. The "fail at 34%" demonstration was removed because it failed on every attempt and could not show recovery.

## Week 3 — Real-time and reliability

- [x] Configure BullMQ attempts and exponential backoff
- [x] Publish a job notice after the PostgreSQL write and fan it out with Socket.IO
- [x] Refetch the REST ledger in Angular on each notice and on reconnect
- [ ] Implement failure classification for transient errors that succeed on a later attempt
- [ ] Add manual retry endpoint and interface
- [ ] Add pending-enqueue reconciliation
- [ ] Test concurrency, worker crashes, and duplicate submissions

## Week 4 — Production polish

- [ ] Add authentication and owner-based authorization
- [ ] Write integration and browser end-to-end tests
- [ ] Configure GitHub Actions CI
- [ ] Deploy frontend, API, worker, PostgreSQL, and Redis
- [ ] Record performance measurements and a demo video
- [ ] Finish the system diagram and architectural tradeoff notes

## Milestones

| Milestone | What must work | State |
| --- | --- | --- |
| M1: API connected | Seeded jobs appear in Angular from PostgreSQL | Done |
| M2: Processing | An uploaded CSV produces a real summary report | Done |
| M3: Reliability | Jobs can fail, retry, recover, and update the dashboard | Live updates work. Manual retry and crash recovery are still open |
| M4: Portfolio | Deployed app, automated tests, documentation, and demo | Documentation started |

## Engineering notes

- **Upload then enqueue.** The file is stored before the job row exists. The job points at `uploads/{uuid}.csv`. Reusing one upload for several jobs is allowed. Idempotency is per job id.
- **Why the API buffers and the worker streams.** Multipart parsing already has the body. Capping it at 10 MB keeps that buffer small. The worker uses `fs.createReadStream` and `csv-parse`, and progress is based on bytes read versus `stat` size. Counting newlines would be wrong when a quoted field contains a line break.
- **Cents, not floats.** Amounts are summed as integer cents and divided at the end, so `10.555` and `2.25` do not drift.
- **Permanent versus retryable.** `PermanentCsvError` becomes BullMQ `UnrecoverableError`. A missing file is permanent. Other I/O errors are thrown so the attempt budget still applies.
- **One result row.** The report is renamed into place, then `JobResult` is upserted on `job_id`. A crash between those steps is repaired by the next attempt, which reads the CSV again from the first row.
- **No fail-every-attempt demo.** An error that happens on every attempt only proves terminal failure. A retry that later succeeds needs a transient fault, and that test is still open.
- **No auth yet.** The upload id is an unguessable UUID. Owner checks arrive with authentication.
- **Sockets notify, PostgreSQL decides.** BullMQ QueueEvents can fire before the ledger write is visible. The worker publishes only after that write commits. The browser throws the notice away and rereads `/jobs/:id`. Reconnect joins the room again and rereads, which covers a laptop that slept through the completion. While the socket is down, the page falls back to a two-second poll. One API process owns the Socket.IO rooms; a second API instance would need a Socket.IO Redis adapter.

