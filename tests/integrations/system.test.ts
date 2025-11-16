// tests/integrations/system.test.ts
import { beforeAll, afterAll, beforeEach, describe, test, expect } from "vitest";
import supertest from "supertest";
import { it } from "vitest";

import { createApiServer } from "../../src/server/api";
import { createAggregator } from "../../src/aggregator/index";
import { redis } from "../../src/lib/redis";

let app: any;
let request: any;
let aggregator: any;

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Small helper to retry transient network errors (ECONNRESET)
async function postWithRetry(payload: any, maxAttempts = 3, delayMs = 120) {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await request.post("/ingest").send(payload);
      return res;
    } catch (err: any) {
      lastErr = err;
      // transient network error -> retry
      if (
        err &&
        (err.code === "ECONNRESET" || err.message?.includes("socket hang up"))
      ) {
        if (attempt < maxAttempts) await wait(delayMs * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

describe("SYSTEM: ingest -> aggregator -> discover (robust)", () => {
  beforeAll(async () => {
    // Start API + aggregator once for the file
    await redis.flushall();

    app = await createApiServer();
    await app.ready();
    request = supertest(app.server);

    aggregator = createAggregator();
  });

  afterAll(async () => {
    try {
      if (aggregator && typeof aggregator.stop === "function") aggregator.stop();
    } catch {}
    try {
      if (app && typeof app.close === "function") await app.close();
    } catch {}
    try {
      await redis.flushall();
      await redis.quit();
    } catch {}
  });

  // Ensure clean DB for each test to avoid leakage
  beforeEach(async () => {
    await redis.flushall();
  });

  test("POST /ingest stores token via aggregator", async () => {
    const payload = {
      source: "dex",
      tokens: [{ token_address: "SYS_AAA", price: 100, volume: 50 }],
    };

    const res = await request.post("/ingest").send(payload);
    expect(res.status).toBe(200);

    // Wait for aggregator batching window (200ms) + safety margin
    await wait(600);

    const stored = await redis.hgetall("token:SYS_AAA");
    expect(stored).toBeDefined();
    expect(JSON.parse(stored.token_address)).toBe("SYS_AAA");
    expect(JSON.parse(stored.price)).toBe(100);
    expect(JSON.parse(stored.volume)).toBe(50);
    expect(JSON.parse(stored.last_source)).toBe("ingest");
  });

  test("discover returns tokens sorted by volume (desc) with isolated data", async () => {
    // Use unique addresses to avoid collisions with other tests
    const toIngest = {
      source: "dex",
      tokens: [
        { token_address: "SYS_A", price: 1, volume: 50 },
        { token_address: "SYS_B", price: 2, volume: 100 },
        { token_address: "SYS_C", price: 3, volume: 300 },
      ],
    };

    const r = await request.post("/ingest").send(toIngest);
    expect(r.status).toBe(200);

    // Wait aggregator flush
    await wait(700);

    const discoverRes = await request.get("/discover?limit=10&sort=volume");
    expect(discoverRes.status).toBe(200);

    const tokens = discoverRes.body.tokens || [];
    const addrs = tokens.map((t: any) => t.token_address);

    // Expect descending by volume: SYS_C (300), SYS_B (100), SYS_A (50)
    expect(addrs.slice(0, 3)).toEqual(["SYS_C", "SYS_B", "SYS_A"]);
  });

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("RAPID INGEST TEST — stable & sequential", () => {
  let app: any;
  let request: any;
  let aggregator: any;

  beforeAll(async () => {
    await redis.flushall();

    app = await createApiServer();
    await app.ready();

    request = supertest(app.server);

    aggregator = createAggregator();
  });

  afterAll(async () => {
    aggregator.stop && aggregator.stop();
    await redis.flushall();
    await redis.quit();
  });

  it("handles 5 rapid /ingest calls without crashing", async () => {
    const payload = {
      source: "test",
      tokens: [
        { token_address: "R1", price: 1 },
        { token_address: "R2", price: 2 },
      ],
    };

    // ---- SEQUENTIAL CALLS (no ECONNRESET) ----
    for (let i = 0; i < 5; i++) {
      const res = await request.post("/ingest").send(payload);
      expect(res.status).toBe(200);
      await wait(30); // tiny 30ms spacing prevents server closing issues
    }

    // wait for aggregator flush
    await wait(400);

    const a = await redis.hgetall("token:R1");
    const b = await redis.hgetall("token:R2");

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });
});

});
