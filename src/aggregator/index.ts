import { sub, pub, redis } from "../lib/redis";

console.log("Aggregator started...");

// -----------------------------------------------------------------------------
// 1. BATCH BUFFER (fix duplicate writes)
// -----------------------------------------------------------------------------

// Stores merged tokens by address within the current 200ms window
const updateBuffer: Record<string, any> = {};

// true → flush already scheduled
let flushScheduled = false;

// Flush buffer to Redis + WebSocket
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;

  setTimeout(async () => {
    flushScheduled = false;

    const entries = Object.entries(updateBuffer);

    for (const [address, mergedToken] of entries) {
      delete updateBuffer[address];

      await writeTokenToRedis(address, mergedToken);

      await pub.publish(
        "state_changes",
        JSON.stringify({ address, diff: mergedToken })
      );
    }
  }, 200); // 200ms batching window
}

// -----------------------------------------------------------------------------
// 2. LISTEN FOR RAW UPDATES
// -----------------------------------------------------------------------------

sub.subscribe("raw_tokens");

sub.on("message", async (_channel, message) => {
  try {
    const payload = JSON.parse(message);
    const { tokens, source, fetched_at } = payload;

    for (const t of tokens) {
      const addr = t.token_address;
      if (!addr) continue;

      // Load existing from Redis
      const existing = await readTokenFromRedis(addr);

      // Merge the new data
      const merged = mergeTokens(existing, t, source, fetched_at);

      // Compute diff vs existing
      const diff = diffObjects(existing, merged);

      // Only keep meaningful changes
      const filteredDiff = filterMeaningfulDiff(diff);
      if (Object.keys(filteredDiff).length === 0) continue;

      // Add to batching buffer
      updateBuffer[addr] = merged;
      scheduleFlush();

      // Pretty-print diff for logs
      prettyPrintDiff(addr, filteredDiff, existing);
    }
  } catch (err) {
    console.error("Aggregator error:", err);
  }
});

// -----------------------------------------------------------------------------
// 3. FILTER OUT USELESS CHANGES
// -----------------------------------------------------------------------------

function filterMeaningfulDiff(diff: any) {
  const ignore = ["_updated_at", "fetched_at", "last_source", "token_address"];

  const meaningful: any = {};

  for (const [key, val] of Object.entries(diff)) {
    if (ignore.includes(key)) continue;
    if (val === null || val === undefined) continue;
    meaningful[key] = val;
  }

  return meaningful;
}

// -----------------------------------------------------------------------------
// 4. LOG PRETTY DIFFS
// -----------------------------------------------------------------------------

function prettyPrintDiff(address: string, diff: any, oldData: any | null) {
  console.log(`\n📌 Token Update → ${address}`);

  for (const [field, newValue] of Object.entries(diff)) {
    const oldValue = oldData ? oldData[field] : undefined;

    const newNum = Number(newValue);
    const oldNum = Number(oldValue);

    // Volume small noise threshold
    if (field === "volume" && !isNaN(newNum) && !isNaN(oldNum)) {
      if (Math.abs(newNum - oldNum) < 20) continue;
    }

    // Liquidity noise threshold
    if (field === "liquidity" && !isNaN(newNum) && !isNaN(oldNum)) {
      if (Math.abs(newNum - oldNum) < 1) continue;
    }

    console.log(
      `  ${field.padEnd(18)} ${String(oldValue).padEnd(12)} → ${newValue}`
    );
  }

  console.log("");
}

// -----------------------------------------------------------------------------
// 5. REDIS — READ & WRITE
// -----------------------------------------------------------------------------

async function readTokenFromRedis(address: string): Promise<any | null> {
  const key = `token:${address}`;
  const data = await redis.hgetall(key);

  if (!data || Object.keys(data).length === 0) return null;

  const parsed: any = {};
  for (const [k, v] of Object.entries(data)) {
    try {
      parsed[k] = JSON.parse(v);
    } catch {
      parsed[k] = v;
    }
  }
  return parsed;
}

async function writeTokenToRedis(address: string, token: any) {
  const key = `token:${address}`;
  const payload: Record<string, string> = {};

  for (const [k, v] of Object.entries(token)) {
    payload[k] = JSON.stringify(v);
  }

  await redis.hset(key, payload);

  if (token.volume !== undefined)
    await redis.zadd("index:volume", token.volume, address);

  if (token.liquidity !== undefined)
    await redis.zadd("index:liquidity", token.liquidity, address);

  if (token.market_cap !== undefined)
    await redis.zadd("index:market_cap", token.market_cap, address);

  if (token.price_24h_change !== undefined)
    await redis.zadd("index:price_change_24h", token.price_24h_change, address);
}

// -----------------------------------------------------------------------------
// 6. MERGE TOKENS FROM MULTIPLE SOURCES
// -----------------------------------------------------------------------------

function mergeTokens(
  existing: any | null,
  incoming: any,
  source: string,
  fetched_at: number
) {
  const result = existing ? { ...existing } : {};

  result.token_address = incoming.token_address;

  if (!result.token_name && incoming.token_name)
    result.token_name = incoming.token_name;

  if (!result.token_ticker && incoming.token_ticker)
    result.token_ticker = incoming.token_ticker;

  const numericFields = [
    "price",
    "market_cap",
    "volume",
    "liquidity",
    "transaction_count",
    "price_1h_change",
    "price_24h_change",
    "price_7d_change",
  ];

  for (const field of numericFields) {
    if (incoming[field] !== undefined && incoming[field] !== null) {
      result[field] = incoming[field];
    }
  }

  result.last_source = source;
  result.fetched_at = fetched_at;
  result._updated_at = Date.now();

  return result;
}

// -----------------------------------------------------------------------------
// 7. CALCULATE DIFF
// -----------------------------------------------------------------------------

function diffObjects(oldObj: any | null, newObj: any) {
  const diff: Record<string, any> = {};

  if (!oldObj) return newObj;

  for (const [key, newValue] of Object.entries(newObj)) {
    const oldValue = oldObj[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      diff[key] = newValue;
    }
  }
  return diff;
}
