# QueueLab

QueueLab accepts a CSV analysis job, records it in PostgreSQL, and lets a separate worker finish it through Redis and BullMQ. The Angular app uploads the file and follows the ledger through a socket.

## Architecture

```text
Angular --HTTP--> NestJS API --enqueue--> Redis / BullMQ --> Worker
   ^                |                         |               |
   |                +-------- PostgreSQL -----+---------------+
   |                |                                         |
   +-- Socket.IO ---+<----- job notice ---- Redis pub/sub ----+
```

BullMQ owns execution: locks, attempts, and backoff. PostgreSQL owns the queryable history: status, progress, events, and result rows. Those two writes are not one transaction. After a durable write, the API or worker publishes a small notice. Socket.IO forwards that notice to open pages. The page then rereads the job from the REST API. A reconnect does the same reread, so a missed notice does not become the state of the screen.

Creating a job:

1. Store the CSV at `uploads/{id}.csv`. The API accepts up to 10 MB and keeps that body in memory only long enough to write it. The original name is display text. The storage name is the id, so a key cannot leave the store. Local development writes that key under `STORAGE_PATH`. Production writes it to an S3-compatible bucket that the API and the worker both use.
2. Insert the job row as `PENDING_ENQUEUE`, pointing at that file.
3. Add a BullMQ job whose id is the execution id and whose payload is the storage key.
4. Mark the row `QUEUED` only after Redis accepts it.

If enqueue fails, the API returns 503 and leaves the row pending. It never claims the job was queued. A reconciler in the API claims pending rows older than 15 seconds with a conditional update, checks Redis for that same execution id, and marks the row queued only after Redis has it. Two API processes cannot enqueue the same row at once.

The worker opens the CSV as a stream. It folds each row into running totals and drops the row. It does not load the file into one string. Amounts are accumulated in integer cents. Invalid rows are counted, and at most 20 reasons are stored. A file that still has valid rows completes. An empty file, a missing required column, a broken quote, or a file where every row is invalid is a permanent error: BullMQ does not spend the remaining retries on it. A later read error that is not a missing file is thrown normally so BullMQ can retry.

The worker is safe to run more than once for the same execution. A completed execution returns immediately. Each attempt reads the CSV from the start. The report is written to `results/{jobId}/{executionId}.json` before the ledger commit, and only while that execution is still current. A newer execution has a different file, so a late writer cannot replace it. `job_results.job_id` is unique, so a later success replaces the summary instead of inserting a second result.

BullMQ notices when a worker dies with the lock unrenewed. It runs that same execution again. `BULLMQ_MAX_STALLED_COUNT` defaults to 1, so one crash is recovered and a second stall fails the execution. The ledger records the stall and, if the limit is passed, the failure. It does not keep retrying forever.

A job id is stable. An execution id is one manual run, and it is also the BullMQ job id. Reusing the job id would collide with the failed queue record. Automatic retries stay inside that execution: attempt 1 can throw, and attempt 2 reads the file again. `POST /jobs/:id/retry` is only for a failed job. It claims the row with `UPDATE ... WHERE status = 'FAILED'`, so a double click creates one new execution. The worker writes the final result only while its execution is still current.

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

Sign in from the app. With `OIDC_ISSUER` unset, the API serves a local OpenID page and asks for an email. That page is only answered when the request host is `localhost`, `127.0.0.1`, or `::1`. The first sign-in as `demo@queuelab.dev` links the seeded user. Any other email gets an empty ledger. The ID token is stored in an HttpOnly, SameSite=Lax cookie and checked on every API and socket request. Cookie mutations also require the `X-QueueLab-Request` header and an `Origin` that matches `WEB_ORIGIN`. Production refuses to boot unless `OIDC_ISSUER`, `OIDC_REDIRECT_URI`, and `WEB_ORIGIN` are https, `OIDC_CLIENT_ID` is set, and `AUTH_COOKIE_SECRET` is at least 16 characters. Production cookies are always Secure. The token check requires the configured issuer, the client id as the audience, a valid signature, and an unexpired `exp`. The callback also checks `state`, PKCE, and `nonce`.

`pnpm docker:up` starts PostgreSQL and Redis. The API, worker, and Angular run on the host so they can reload. A PostgreSQL 17 and Redis already listening on `localhost:5432` and `localhost:6379` work with the same `.env`. `docker compose -f infrastructure/docker-compose.yml --profile full up --build` runs the API and worker in containers instead.

Seeded jobs are labeled Sample. They are ledger rows only, so their progress does not move. Their reports are generated from the job id because they have no uploaded file. Dispatch a CSV from New job to watch a live run.

## Tests

```bash
pnpm test
pnpm --filter @queuelab/web test
```

`pnpm test` builds the shared packages, then runs the shared-type tests, the worker tests, and the API tests. The API tests start their own Nest process and need PostgreSQL and Redis. Angular tests cover the return path used after sign-in.

## CI

GitHub Actions runs on every push and pull request. The workflow is `.github/workflows/ci.yml`. One job installs with a frozen lockfile, typechecks, lints, scans tracked files for secrets, validates the Prisma schema, applies migrations to a disposable PostgreSQL, and runs the API, worker, and Angular tests plus the production web build. A second job builds the API, worker, and web images and does not push them. Deploy is a separate step after those checks pass.

The runner sets:

| Variable | CI value |
| --- | --- |
| `DATABASE_URL` | `postgresql://queuelab:queuelab@localhost:5432/queuelab?schema=public` |
| `REDIS_URL` | `redis://localhost:6379` |
| `WEB_ORIGIN` | `http://localhost:4200` |
| `DEMO_USER_EMAIL` | `demo@queuelab.dev` |

`OIDC_ISSUER` stays empty so the tests use the local issuer on `127.0.0.1`.

The same checks can be run locally:

```bash
pnpm install --frozen-lockfile
pnpm build:packages
pnpm typecheck
pnpm lint
pnpm secrets
pnpm db:validate
pnpm db:deploy
pnpm test
pnpm --filter @queuelab/web test
pnpm --filter @queuelab/web build
pnpm audit --audit-level high
```

`pnpm db:deploy` applies committed migrations to whatever `DATABASE_URL` is set. Point it at a disposable database.

## Performance

Local measurements from [docs/benchmarks.md](docs/benchmarks.md), taken on an Apple M5 with 16 GiB of memory, Homebrew PostgreSQL 17, and Redis 8. Each of 20 jobs analyzed the same 280,000-row CSV (7.3 MB). `pnpm dev` was also running.

```mermaid
xychart-beta
    title "Jobs completed per minute"
    x-axis "Worker processes" [1, 2, 4, 8]
    y-axis "Jobs per minute" 0 --> 400
    bar [93.7, 192, 320.8, 351.4]
```

```mermaid
xychart-beta
    title "Median processing time"
    x-axis "Worker processes" [1, 2, 4, 8]
    y-axis "Milliseconds" 0 --> 1500
    bar [629, 615, 734, 1242]
```

| Workers | Jobs/min | Submit p50 / p95 | Queue wait p50 / p95 | Process p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 93.7 | 6 ms / 8 ms | 5.8 s / 11.4 s | 629 ms / 671 ms |
| 2 | 192.0 | 5 ms / 7 ms | 2.6 s / 5.5 s | 615 ms / 680 ms |
| 4 | 320.8 | 6 ms / 11 ms | 1.6 s / 2.9 s | 734 ms / 800 ms |
| 8 | 351.4 | 13 ms / 21 ms | 1.3 s / 2.4 s | 1,242 ms / 1,329 ms |

Eight processes finished 3.75 times as many jobs per minute as one process. At eight, each job took about twice as long to process.

Killing the worker at 23% progress, then starting a replacement immediately, took 30.8 seconds, 60.9 seconds, and 60.9 seconds to reach a completed job. Rereading the file was about 0.65 seconds of that. The rest is BullMQ's 30 second lock and 30 second stall check. Repeat the run with `pnpm bench`.

## Production

`render.yaml` is the public deployment, and it is not applied yet. The Angular image is the only public HTTPS service. Nginx proxies `/api` and `/socket.io` to the private API using Render's `hostport` for that service, so the address is the internal hostname Render assigns rather than a guessed name. A separate worker reads the same Redis queue. PostgreSQL and Key Value are managed. CSV uploads and JSON reports go to object storage.

Render's free plan covers a public web service, but not a private service or a background worker. Those start at $7 each. The blueprint pins the smallest plans that keep the database and the queue across restarts:

| Piece | Plan | Monthly |
| --- | --- | --- |
| Public web | `free` | $0 |
| Private API | `0.5c-512mb` | $7 |
| Worker | `0.5c-512mb` | $7 |
| Postgres, 1 GB disk | `0.1c-256mb` | $6 |
| Key Value, persistent | `256mb` | $10 |

That is about $30 per month before any extra database disk. A free Postgres instance expires after 30 days, and a free Key Value instance drops its data on restart. The free web service can call the private API, and it sleeps when nobody is using it.

Production refuses to boot without `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`, and without the https OpenID settings in `.env.example`. For Cloudflare R2 set `S3_REGION` to `auto` and `S3_ENDPOINT` to the account's R2 endpoint. Leave `S3_BUCKET` empty on a laptop. The local directory is `STORAGE_PATH`.

Create the bucket first. Then connect the GitHub repository so Render can read this blueprint, but do not sync it until the monthly total is accepted. The first deploy fails closed until the secrets exist. Copy the web service origin, register that origin plus `/api/v1/auth/callback` on the OpenID provider, and enter the issuer, client, redirect, and bucket credentials in the Render environment group. The sign-in request uses the provider's discovered authorization endpoint, so Google and Auth0 do not have to share a path. The Render CLI on this machine is not signed in.

## Layout

- `apps/web` — Angular shell, dashboard, job list, detail, and upload form
- `apps/api` — NestJS REST API and Swagger
- `apps/worker` — BullMQ processor and streaming CSV analysis
- `packages/database` — Prisma schema, migrations, and seed
- `packages/shared-types` — status unions, payloads, and row aggregation
- `packages/storage` — local directory or S3-compatible object store
- `infrastructure` — Compose file and Dockerfiles

## Not in this slice

- Cancellation
- Browser end-to-end tests

The checklist and the reasons for these choices are in [docs/roadmap.md](docs/roadmap.md).
