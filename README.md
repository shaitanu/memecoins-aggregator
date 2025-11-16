# MemeCoins Aggregator

**One-line:** a modular, scalable service that aggregates meme-coin data from multiple DEX sources, merges & caches the results in Redis and pushes real-time updates to clients over WebSocket.

---

## Table of contents
- [Why this project](#why-this-project)
- [Features](#features)
- [High-level architecture](#high-level-architecture)
- [Data flow (summary)](#data-flow-summary)
- [Components & responsibilities](#components--responsibilities)
- [How merging & deduplication works](#how-merging--deduplication-works)
- [Caching & indices (Redis design)](#caching--indices-redis-design)
- [Rate limiting, retries & exponential backoff](#rate-limiting-retries--exponential-backoff)
- [Batching & reducing duplicate writes](#batching--reducing-duplicate-writes)
- [Local development — run order & commands](#local-development--run-order--commands)
- [Environment variables (`.env`)](#environment-variables-env)
- [API endpoints & examples](#api-endpoints--examples)
- [Postman collection](#postman-collection)
- [Testing](#testing)
- [Troubleshooting / common errors](#troubleshooting--common-errors)
- [Scaling & production notes](#scaling--production-notes)
- [Future improvements](#future-improvements)
- [License](#license)

---

## Why this project
This service replicates the **discover** pattern used by modern token aggregators (e.g. axiom.trade): fetch token/pair data from multiple DEX APIs, normalize them to a common schema, merge duplicates, cache results for fast reads, and stream compact updates to many clients.

It's built to show good engineering practices: modular workers, robust HTTP client with retries & backoff, Redis-based state & indices, WebSocket broadcasting, batching to reduce churn and moderate test coverage.

---

## Features
- Fetch from **DexScreener** and **Jupiter** (you implemented these) with pluggable fetchers
- Per-fetch exponential backoff and concurrency limiting (`p-limit`) to avoid hammering upstream APIs
- Deduplication & normalization per-source (normalizers)
- Redis hash storage per token + sorted-set indices (`zadd`) for sorting by `volume`, `liquidity`, `market_cap`, etc.
- Short TTL caching strategy for fetchers (configurable, default 30s reduces API calls)
- Aggregator that **merges** incoming partial data, filters noisy updates, and publishes compact diffs on state changes
- WebSocket server to stream `state_changes` updates to clients
- REST API (`/discover`) to get sorted & paginated token lists (cursor-based)
- `/ingest` internal endpoint for the fetchers to push normalized tokens into the ingestion pipeline (used in testing & internal flow)
- Tests: unit tests for core logic (merge/diff/filter/normalizers) and minimal integration tests (ingest + aggregator + discover)
- Ready-to-import Postman collection for reviewers

---

## High-level architecture

```
[Fetcher Workers]   (DexScreener, Jupiter)   --->  POST /ingest (or publish raw_tokens)  ---> [Aggregator]
                                                                  |                            |
                                                                  v                            v
                                             (Redis Pub/Sub raw_tokens, state_changes)   [Redis: hashes + zsets]
                                                                                               |
                                                                                               v
        [API Server /discover + health] <--- reads from Redis (hashes + zsets)      [WebSocket Server] <-- subscribes state_changes
                                                                                               |
                                                                                               v
                                                                                             Clients
```

- Fetchers call external APIs, normalize results, and call the internal `/ingest` or publish to `raw_tokens` pubsub channel.
- Aggregator listens on `raw_tokens` channel, merges incoming data into an in-memory buffer, and flushes batched updates to Redis + publishes compact `state_changes` diffs via Redis Pub/Sub.
- WebSocket server subscribes to `state_changes` and broadcasts diffs to connected clients.
- API server reads stable snapshots from Redis to serve `/discover` requests.

---

## Data flow (summary)
1. Worker fetches token data from DexScreener (boosts → token details) and / or Jupiter (prices)
2. Worker normalizes each token to the project's `TokenDto` shape
3. Worker sends normalized tokens to the ingest API (`POST /ingest`) or publishes to `raw_tokens` (depending on config)
4. Aggregator receives raw normalized tokens, merges them (source union, prefer newest values where applicable), batches updates for ~200ms, writes the merged snapshot to Redis (`HSET token:<address>`) and updates sorted sets (`ZADD index:volume <score> <token_address>`, etc.)
5. Aggregator publishes compact diffs to `state_changes`
6. WebSocket server broadcasts diffs; clients update UI locally without re-requesting `/discover` for filtering/sorting

---

## Components & responsibilities
- **Fetchers (workers)** (`src/workers/*`)
  - Responsible for polling external DEX APIs, normalizing raw responses and sending them to `/ingest`.
  - Use concurrency limiter (`p-limit`) and `axios` with retry interceptor that implements exponential backoff.

- **Ingest API** (`POST /ingest`) in API server
  - Lightweight: validates the incoming payload then publishes to Redis pubsub channel `raw_tokens`.
  - Protects upstream from heavy writes; it's the canonical internal entry point for normalized tokens.

- **Aggregator** (`aggregator-runner`)
  - Listens on pub/sub `raw_tokens` and merges incoming normalized messages into a local buffer.
  - Batch window (200ms) to coalesce multiple rapid inputs for the same token and avoid thrashing Redis.
  - Writes merged snapshot to Redis & updates indices (zsets). Publishes compact diffs to `state_changes`.

- **Redis**
  - `HSET token:<address>` stores per-token snapshot (JSON-stringified fields)
  - `ZADD index:<metric>` stores addresses indexed by numeric metric for fast sorting & pagination (e.g., `index:volume`)
  - Pub/Sub channels: `raw_tokens` (input), `state_changes` (incremental diffs for WS)

- **API Server** (`api-runner`) uses Fastify
  - Exposes `/discover`, `/ingest` (internal), `/health`.
  - `discover` reads sorted token addresses via `ZREVRANGE` then `HGETALL` each token.
  - Cursor-based pagination: `limit` + `cursor` (nextCursor = cursor + limit)

- **WebSocket Server** (`ws-runner`) uses `ws`
  - Subscribes `state_changes` and broadcasts to all connected clients

- **UI (example/demo)**
  - On load: call `/discover` to get initial page
  - Maintain a token map in memory
  - WebSocket updates apply diffs to the map (no additional HTTP calls needed for filtering/sorting)

---

## How merging & deduplication works
- Each normalized message includes `token_address` and a set of fields (price, volume, liquidity...).
- Aggregator `mergeBuffered()` merges multiple incoming partial objects for the same token within the batching window, unioning the `sources_used` array and preferring the latest non-null values.
- When flushing, the aggregator reads the existing token snapshot from Redis once, calls `mergeTokens(existing, incoming, 'ingest', fetched_at)` and computes the diff (`diffObjects`). Only *meaningful* diffs are written/published.
- This avoids ping-pong or thrashing when multiple sources report slightly different values in rapid succession.

---

## Caching & indices (Redis design)
- Per-token: `HSET token:<address> { field: JSON.stringify(value), ... }`
  - Storing as strings keeps retrieval simple and avoids partial-type mismatches during reads
- Indices for sorting: `ZADD index:volume <score> <address>` etc.
  - `discover` queries `ZREVRANGE` (highest-first) and then `HGETALL` for each returned address
- TTL / caching on fetchers: fetchers should avoid re-calling external APIs for the same token more often than necessary (default TTL 30s) — achieved by local cache / rate-limited fetch cycles.

---

## Rate limiting, retries & exponential backoff
- `axios` instance has a response interceptor that retries on 429 or 5xx with exponential backoff: `delay = Math.pow(2, retryCount) * baseMs`.
- Concurrency limiter (`p-limit`) prevents excessive open parallel requests — default 5 concurrent requests to external services.
- Fetchers should respect provider rate-limits (e.g., DexScreener 300 req/min) — achieved via chunking + concurrency control.

---

## Batching & reducing duplicate writes
- Aggregator collects all incoming normalized updates for a 200ms window into `updateBuffer` keyed by address.
- On flush it merges buffered data with existing snapshot, computes compact diff and only writes + publishes when there are meaningful changes.
- This reduces Redis writes and WebSocket noise considerably.

---

## Local development — run order & commands
**Important:** run runners in this exact order to get a healthy backend pipeline:

1. **Start Redis** (required) — local Redis on default `127.0.0.1:6379` or configure `REDIS_URL`.

```bash
# if you have docker
docker run -p 6379:6379 --name eterna-redis -d redis:7-alpine
```

2. **API server**
```bash
# from project root
npx ts-node src/api-runner.ts
# or if you added npm scripts:
# npm run start:api
```

3. **Aggregator**
```bash
npx ts-node src/aggregator-runner.ts
# or npm run start:aggregator
```

4. **WebSocket server**
```bash
npx ts-node src/ws-runner.ts
# or npm run start:ws
```

5. **Worker(s) / Fetchers**
```bash
npx ts-node src/worker-runner.ts
# or npm run start:workers
```

> The order matters because:
> - API needs Redis to be available first
> - Aggregator must be running to process `raw_tokens` published by /ingest
> - WS server should be running to broadcast `state_changes`
> - Workers publish normalized tokens to ingest / raw_tokens


---

## Environment variables (`.env`)
Provide these in a `.env` file at the repo root (example):

```
REDIS_URL=redis://127.0.0.1:6379
FETCH_INTERVAL=8000         # worker poll interval (ms)
CACHE_TTL=30                # seconds (fetcher caching)
PORT=3000                   # API server port
WS_PORT=4000                # WebSocket server port
```

---

## API endpoints & examples
- **POST /ingest** — internal endpoint used by fetchers/tests
  - Body `{ source: string, tokens: TokenDto[] }`
  - Example:
    ```json
    {
      "source":"dex",
      "tokens":[{"token_address":"AAA","price":10,"volume":20}]
    }
    ```

- **GET /discover?sort=volume&limit=20&cursor=0**
  - Returns `{ tokens: [...], nextCursor: number }` (cursor-based pagination)
  - `sort` options: `volume`, `liquidity`, `market_cap`, `price_change_24h`

- **GET /health**
  - Returns `{ status: 'ok', uptime, token_count }`

---

## Postman collection
- `Eterna.postman_collection.json` included in repo root (or generated earlier). Import into Postman / Insomnia and run.

---

## Testing
- Unit tests: run `vitest` (or `npm test` if script is defined).
- Integration tests (minimal & stable): use the `tests/integrations/*` suite (these spin up Fastify + aggregator + redis in-process).

Example:
```bash
# run unit tests
npx vitest run

# or integration tests (if configured)
npx vitest
```

> TIP: If integration tests fail intermittently, make sure Redis is clean (`redis.flushall()`) and runners are started in order. The test suite includes a small batching delay (200–400ms) to allow aggregator flushes.

---

## Troubleshooting / common errors
- **Redis connection refused**: start Redis or point `REDIS_URL` correctly.
- **ESM `p-limit` error**: use the default `p-limit` import pattern used in this project or run Node with compatible flags; for local dev we used `p-limit` via `import pLimit from 'p-limit'` and TypeScript config compatible with Node v20+.
- **`WebSocket closed before connection` in browser**: ensure WS server is running on configured port and no firewall blocks it.
- **Tests failing intermittently**: ensure test-runner isolates Redis (use `flushall()` at start) and that aggregator is registered only once (remove extra listeners when reloading in tests).

---

## Scaling & production notes
- **Workers** can be horizontally scaled — they are idempotent producers. Use a shared Redis for pub/sub and state.
- **Aggregator**: single aggregator per Redis is simplest (to avoid write races). For HA, you can partition by token-address sharding (consistent hashing) or use a leader-election mechanism.
- **WebSocket**: scale via a WebSocket cluster + sticky sessions, or use a message broker (Redis pub/sub or Kafka) and small WS frontends that broadcast to connected clients.
- **Persistence**: optionally persist snapshots to a long-term DB if you need historical data.

---


## Demo UI (Frontend)

A lightweight demo frontend is included in the repo to visualize:

-   Live token table
    
-   Real-time WebSocket updates
    
-   Change-highlighting (diff-based updates)
    
-   Rapid refresh behavior
    
-   Sorting & basic rendering
    

### 📁 Location

`/memecoin-ui`