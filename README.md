# QueueLab

QueueLab accepts a CSV analysis job, records it in PostgreSQL, and lets a separate worker finish it through Redis and BullMQ. The Angular app uploads the file and polls the ledger for progress.

## Architecture

```text
Angular  --HTTP-->  NestJS API  --enqueue-->  Redis / BullMQ  -->  Worker
                      |                                          |
                      +-------------- PostgreSQL ----------------+
                      |
                      +--------- storage/ (CSV + report JSON) ---+
```

BullMQ owns execution: locks, attempts, and backoff. PostgreSQL owns the queryable history: status, progress, events, and result rows. Those two writes are not one transaction.

Creating a job:

1. Store the CSV under `storage/uploads/{id}.csv`. The API accepts up to 10 MB and keeps that body in memory only long enough to write it. The original name is display text. The storage name is the id, so a filename cannot leave the storage directory.
2. Insert the job row as `PENDING_ENQUEUE`, pointing at that file.
3. Add a BullMQ job whose id is the same UUID and whose payload is the storage key.
4. Mark the row `QUEUED` only after Redis accepts it.

If enqueue fails, the API returns 503 and leaves the row pending. It never claims the job was queued. A reconciler for stranded `PENDING_ENQUEUE` rows is not built yet.

The worker opens the CSV as a stream. It folds each row into running totals and drops the row. It does not load the file into one string. Amounts are accumulated in integer cents. Invalid rows are counted, and at most 20 reasons are stored. A file that still has valid rows completes. An empty file, a missing required column, a broken quote, or a file where every row is invalid is a permanent error: BullMQ does not spend the remaining retries on it. A later read error that is not a missing file is thrown normally so BullMQ can retry.

The worker is safe to run more than once. A completed job returns immediately. Each attempt reads the file from the start. The report is written to a temporary file and renamed over `results/{jobId}.json`, and `job_results.job_id` is unique, so a retry replaces the report instead of inserting a second result.

`POST /jobs/:id/retry` returns 501. BullMQ still retries an unexpected worker error up to 3 times. The earlier "fail at 34%" form option was removed: it failed on every attempt, so it could not show a retry that later succeeds. That case belongs with the manual-retry milestone.

Required columns are `order_id`, `sku`, `quantity`, and `amount`. Header names are matched without case or spacing. Quantity must be a non-negative number. Amount may be negative. Extra columns are ignored.

## Run it

Requirements: Node 22, pnpm 10, and Docker.

```bash
cp .env.example .env
pnpm install
pnpm docker:up
pnpm --filter @queuelab/database exec prisma migrate dev --name init
pnpm db:seed
pnpm dev
```

- App: http://localhost:4200
- API docs: http://localhost:3000/api/docs
- Health: http://localhost:3000/api/v1/health

`pnpm docker:up` starts PostgreSQL and Redis. The API, worker, and Angular run on the host so they can reload. A PostgreSQL 17 and Redis already listening on `localhost:5432` and `localhost:6379` work with the same `.env`. `docker compose -f infrastructure/docker-compose.yml --profile full up --build` runs the API and worker in containers instead.

Seeded jobs are labeled Sample. They are ledger rows only, so their progress does not move. Their reports are generated from the job id because they have no uploaded file. Dispatch a CSV from New job to watch a live run.

## Tests

```bash
pnpm test
```

Unit tests cover cursor pagination, row validation, and a streaming parse of a temporary CSV, including a broken quote and a second read of the same file.

## Layout

- `apps/web` — Angular shell, dashboard, job list, detail, and upload form
- `apps/api` — NestJS REST API and Swagger
- `apps/worker` — BullMQ processor and streaming CSV analysis
- `packages/database` — Prisma schema, migrations, and seed
- `packages/shared-types` — status unions, payloads, and row aggregation
- `infrastructure` — Compose file and Dockerfiles

## Not in this slice

- Socket.IO live events
- Manual retry, cancellation, and pending-enqueue reconciliation
- A transient failure that succeeds on a later attempt
- Authentication and owner checks
- CI, browser end-to-end tests, and deployment

The checklist and the reasons for these choices are in [docs/roadmap.md](docs/roadmap.md).
