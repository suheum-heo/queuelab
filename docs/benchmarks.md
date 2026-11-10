# QueueLab performance

Measured 2026-11-10T05:49:05.673Z on one machine. Every counted run used the same CSV, the same local PostgreSQL and Redis, and a freshly started API. The public Render services were not running. `pnpm dev` was already running an API, one worker, and Angular. That worker listens on `csv-analysis`, so it did not take these jobs. It did share the CPU, PostgreSQL, and Redis. The load average at the start of the script was 5.92.

## Hardware

| | |
| --- | --- |
| CPU | Apple M5 (10 logical) |
| Memory | 16 GiB |
| OS | darwin 25.2.0 |
| Node | v22.23.1 |
| PostgreSQL | PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin25.6.0 |
| Redis | 8.10.2 |
| Load average at start | 5.92 |
| Postgres sessions already open | 7 of 100 |

## Fixture

A smaller file was timed once and discarded. The counted runs reused one upload of the file below.

| | |
| --- | --- |
| Data rows | 280,000 |
| Invalid rows | 5,600 (every 50th quantity is `x`) |
| Size | 7,252,031 bytes |
| SHA-256 | `21095bda4ac2bfe57883b1698041f0c55a4287926f24d3c47500f634ccc83ede` |
| Stream parse, no database | 354 ms |
| One full job, excluded from the tables | 698 ms |

Columns are `order_id`, `sku`, `quantity`, and `amount`. The generator is in `scripts/benchmark.ts`. Row `i` is invalid when `i % 50 === 0`.

## How the numbers were taken

- 20 jobs per concurrency level. Requests were sent one at a time to `POST /api/v1/jobs` on a local API at port 3199.
- Worker counts were 1, 2, 4, 8 operating-system processes. Each process had `WORKER_CONCURRENCY=1`.
- The queue name was `csv-analysis-bench-54599`, so the development worker on `csv-analysis` did not take these jobs.
- Each API process used at most 5 Postgres connections, and each worker at most 2, so eight workers fit under the local connection cap.
- Submission latency is the client time for the 202 response.
- Queue wait is `startedAt` minus the `QUEUED` event time. Both come from PostgreSQL.
- Processing time is `finishedAt - startedAt`. It includes the stream, the progress writes, the report write, and the completion transaction. None of these jobs stalled.
- Throughput is 20 divided by the time from the first job's `createdAt` to the last job's `finishedAt`.
- Percentiles use nearest-rank, rank = ceil(p/100 * n). With 20 samples, p95 is the 19th sorted value.
- Recovery used the production stall settings: lock 30000 ms, check every 30000 ms, and at most 1 stall. The worker was `SIGKILL`ed once progress reached at least 20%. A replacement process was started as soon as the killed process exited. The clock starts at the kill.

## Results

| Workers | Jobs/min | Makespan (s) | Submit p50 (ms) | Submit p95 (ms) | Queue p50 (ms) | Queue p95 (ms) | Process p50 (ms) | Process p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 93.7 | 12.8 | 6 | 8 | 5791 | 11442 | 629 | 671 |
| 2 | 192.0 | 6.2 | 5 | 7 | 2633 | 5530 | 615 | 680 |
| 4 | 320.8 | 3.7 | 6 | 11 | 1568 | 2916 | 734 | 800 |
| 8 | 351.4 | 3.4 | 13 | 21 | 1253 | 2416 | 1242 | 1329 |

One worker completed 93.7 jobs per minute. Eight workers completed 351.4, which is 3.75 times the single-worker rate, not 8 times. Processing time stayed near 630 ms through four workers and rose to 1,242 ms at eight, so the extra processes were waiting on each other. Submission stayed a small part of the wait: p95 was 8 ms with one worker and 21 ms with eight. The long queue times with one worker are the other 19 jobs sitting behind a 630 ms file.

### Recovery

| Trial | Progress at kill | Kill to stall event (ms) | Kill to resume (ms) | Redo the file (ms) | Kill to completed (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 23% | 30179 | 30183 | 655 | 30838 |
| 2 | 23% | 60202 | 60208 | 658 | 60866 |
| 3 | 23% | 60219 | 60221 | 634 | 60855 |

The resumed execution reads the CSV from the first row. `startedAt` is not reset, so the redo column is the time from the second `PROCESSING` event to `finishedAt`, and the last column is the whole gap the caller waits through. Rereading the file took 634–658 ms, in line with the single-worker processing time. The rest of the 31–61 seconds was the wait until BullMQ noticed the dead worker. The median time from the kill to a completed job was 60.9 seconds.

Raw samples are in [benchmarks.json](benchmarks.json). Run `pnpm bench` to repeat this on the same fixture rules.
