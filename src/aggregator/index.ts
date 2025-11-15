import { sub, pub, redis } from "../lib/redis";

console.log("Aggregator started...");

// Listen to raw token updates from fetchers
sub.subscribe("raw_tokens");

sub.on("message", async (_channel, message) => {
  try {
    const payload = JSON.parse(message);

    const { tokens, source, fetched_at } = payload;

    for (const t of tokens) {
      const addr = t.token_address;
      if (!addr) continue;

      // Load existing token from Redis
      const existing = await readTokenFromRedis(addr);

      // Merge with new data
      const merged = mergeTokens(existing, t, source, fetched_at);

      // Detect differences
      const diff = diffObjects(existing, merged);

      // If something changed → write + publish diff
      if (Object.keys(diff).length > 0) {
        await writeTokenToRedis(addr, merged);
        await pub.publish("state_changes", JSON.stringify({ address: addr, diff }));
      }
    }

  } catch (err) {
    console.error("Aggregator error:", err);
  }
});
//
// 1. Read existing token from Redis
//
async function readTokenFromRedis(address: string): Promise<any | null> {
  const key = `token:${address}`;
  const data = await redis.hgetall(key);

  if (!data || Object.keys(data).length === 0) return null;

  const parsed: any = {};
  for (const [k, v] of Object.entries(data)) {
    try {
      parsed[k] = JSON.parse(v); // values are stored as JSON
    } catch {
      parsed[k] = v;
    }
  }
  return parsed;
}

//
// 2. Write merged token back to Redis
//
async function writeTokenToRedis(address: string, token: any) {
  const key = `token:${address}`;
  const payload: Record<string, string> = {};

  // Save everything as JSON strings
  for (const [k, v] of Object.entries(token)) {
    payload[k] = JSON.stringify(v);
  }

  // Write hash to Redis
  await redis.hset(key, payload);

  // Update sorted sets for API sorting
  if (token.volume !== undefined) {
    await redis.zadd("index:volume", token.volume, address);
  }

  if (token.liquidity !== undefined) {
    await redis.zadd("index:liquidity", token.liquidity, address);
  }

  if (token.market_cap !== undefined) {
    await redis.zadd("index:market_cap", token.market_cap, address);
  }

  if (token.price_24h_change !== undefined) {
    await redis.zadd("index:price_change_24h", token.price_24h_change, address);
  }
}

//
// 3. Merge old token data with new incoming data
//
function mergeTokens(
  existing: any | null,
  incoming: any,
  source: string,
  fetched_at: number
) {
  const result = existing ? { ...existing } : {};

  // Always keep address
  result.token_address = incoming.token_address;

  // Name / Ticker: keep existing unless new one is better
  if (!result.token_name && incoming.token_name) {
    result.token_name = incoming.token_name;
  }
  if (!result.token_ticker && incoming.token_ticker) {
    result.token_ticker = incoming.token_ticker;
  }

  // Merge numeric fields only if incoming is valid
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

  // Save last source + timestamps
  result.last_source = source;
  result.fetched_at = fetched_at;
  result._updated_at = Date.now();

  return result;
}
//
// 4. Compute the difference between old and new token objects
//
function diffObjects(oldObj: any | null, newObj: any) {
  const diff: Record<string, any> = {};

  if (!oldObj) {
    // If no previous data, everything is a change
    return newObj;
  }

  for (const [key, newValue] of Object.entries(newObj)) {
    const oldValue = oldObj[key];

    // Compare using JSON.stringify to handle numbers, strings, nulls
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      diff[key] = newValue;
    }
  }

  return diff;
}