import { sub, pub, redis } from "../lib/redis";

console.log("Aggregator started...");

// -----------------------------------------------------------------------------
// 1. BATCH BUFFER (collect merged entries from /ingest)
// -----------------------------------------------------------------------------

// buffer stores incoming merged tokens (from /ingest) grouped by address
const updateBuffer: Record<string, any> = {};

// true → flush already scheduled
let flushScheduled = false;

// helper: merge two buffered objects (a and b are partial merged tokens from /ingest)
function mergeBuffered(a: any | null, b: any) {
  if (!a) return { ...b };
  if (!b) return { ...a };

  const out: any = { ...a };

  // union sources_used arrays if present
  if (Array.isArray(a.sources_used) || Array.isArray(b.sources_used)) {
    const s = new Set<string>((a.sources_used || []).concat(b.sources_used || []));
    out.sources_used = Array.from(s);
  }

  // copy fields from b that are defined (prefer b's values when present)
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || v === null) continue;
    // if it's a nested 'sources' object, merge shallowly
    if (k === "sources" && typeof v === "object") {
      out.sources = out.sources || {};
      for (const [sk, sv] of Object.entries(v as any)) {
        out.sources[sk] = sv;
      }
      continue;
    }

    out[k] = v;
  }

  // keep most recent fetched_at if available
  if (b.fetched_at && (!a.fetched_at || b.fetched_at > a.fetched_at)) {
    out.fetched_at = b.fetched_at;
  }

  return out;
}

// -----------------------------------------------------------------------------
// 2. FLUSH BUFFER TO REDIS + PUBSUB
// -----------------------------------------------------------------------------

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;

  setTimeout(async () => {
    flushScheduled = false;

    // copy keys and clear buffer early to accept new incoming while flushing
    const entries = Object.entries(updateBuffer);
    for (const k of Object.keys(updateBuffer)) delete updateBuffer[k];

    if (entries.length === 0) return;

    // For each buffered address, read existing once, merge with existing, compute diff, and write if needed
    for (const [address, bufferedToken] of entries) {
      try {
        const existing = await readTokenFromRedis(address);

        // mergedToken: merge existing DB snapshot with incoming buffered object
        // we set source 'ingest' and fetched_at from bufferedToken.fetched_at (or Date.now)
        const mergedToken = mergeTokens(existing, bufferedToken, "ingest", bufferedToken?.fetched_at || Date.now());

        // Compute diff vs existing
        const diff = diffObjects(existing, mergedToken);
        const filteredDiff = filterMeaningfulDiff(diff);

        if (Object.keys(filteredDiff).length === 0) {
          // nothing meaningful changed — skip write
          continue;
        }

        // Write single merged snapshot for this address
        await writeTokenToRedis(address, mergedToken);

        // Publish only the filtered diff to state_changes (compact)
        await pub.publish("state_changes", JSON.stringify({ address, diff: filteredDiff }));

        // Pretty-print for logs
        prettyPrintDiff(address, filteredDiff, existing);
      } catch (err) {
        console.error("Aggregator flush error for", address, err);
      }
    }
  }, 200); // batching window (200ms)
}

// -----------------------------------------------------------------------------
// 3. LISTEN FOR RAW BATCHES (from /ingest which publishes raw_tokens)
// -----------------------------------------------------------------------------

sub.subscribe("raw_tokens");

sub.on("message", async (_channel: string, message: string) => {
  try {
    const payload = JSON.parse(message);
    // payload expected: { tokens: [ { token_address, ...merged fields... } ], ingested_at?: number }
    const tokens: any[] = payload?.tokens || [];

    for (const t of tokens) {
      const addr = t?.token_address;
      if (!addr) continue;

      // Merge into in-memory buffer (may merge multiple sources that arrive in same window)
      updateBuffer[addr] = mergeBuffered(updateBuffer[addr] || null, t);
    }

    // schedule flush (if not already scheduled)
    scheduleFlush();
  } catch (err) {
    console.error("Aggregator error parsing raw_tokens:", err);
  }
});

// -----------------------------------------------------------------------------
// 4. FILTER OUT USELESS CHANGES
// -----------------------------------------------------------------------------

function filterMeaningfulDiff(diff: any) {
  const ignore = ["_updated_at", "fetched_at", "last_source", "token_address", "sources_used"];

  const meaningful: any = {};

  for (const [key, val] of Object.entries(diff)) {
    if (ignore.includes(key)) continue;
    if (val === null || val === undefined) continue;

    // small noise filters (keep here so aggregator controls noise)
    if (key === "volume") {
      const num = Number(val);
      if (!isNaN(num) && Math.abs(num) < 1e-6) continue;
    }

    meaningful[key] = val;
  }

  return meaningful;
}

// -----------------------------------------------------------------------------
// 5. LOG PRETTY DIFFS
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

    console.log(`  ${field.padEnd(18)} ${String(oldValue).padEnd(12)} → ${newValue}`);
  }

  console.log("");
}

// -----------------------------------------------------------------------------
// 6. REDIS — READ & WRITE
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

  if (token.volume !== undefined) await redis.zadd("index:volume", token.volume, address);
  if (token.liquidity !== undefined) await redis.zadd("index:liquidity", token.liquidity, address);
  if (token.market_cap !== undefined) await redis.zadd("index:market_cap", token.market_cap, address);
  if (token.price_change_24h !== undefined)
    await redis.zadd("index:price_change_24h", token.price_change_24h, address);

}

// -----------------------------------------------------------------------------
// 7. MERGE TOKENS (existing DB snapshot + incoming merged object)
// -----------------------------------------------------------------------------

function mergeTokens(existing: any | null, incoming: any, source: string, fetched_at: number) {
  const result = existing ? { ...existing } : {};

  result.token_address = incoming.token_address;

  // Prefer name/ticker from incoming if missing in existing
  if ((!result.token_name || result.token_name === "") && incoming.token_name) result.token_name = incoming.token_name;
  if ((!result.token_ticker || result.token_ticker === "") && incoming.token_ticker) result.token_ticker = incoming.token_ticker;

  // Numeric fields we care about
  const numericFields = [
    "price",
    "market_cap",
    "volume",
    "liquidity",
    "transaction_count",
    "price_change_24h", 
    "price_change_1h",
    "price_change_7d",
  ];

  for (const field of numericFields) {
    // If incoming has a defined value use it — ingest already did per-cycle priority
    if (incoming[field] !== undefined && incoming[field] !== null) {
      result[field] = incoming[field];
    }
  }

  // Merge sources_used list (union)
  if (Array.isArray(result.sources_used) || Array.isArray(incoming.sources_used)) {
    const s = new Set<string>([...(result.sources_used || []), ...(incoming.sources_used || [])]);
    result.sources_used = Array.from(s);
  }

  // last_source / fetched timestamps
  result.last_source = source;
  result.fetched_at = fetched_at || Date.now();
  result._updated_at = Date.now();

  return result;
}

// -----------------------------------------------------------------------------
// 8. DIFF FUNCTION
// -----------------------------------------------------------------------------

function diffObjects(oldObj: any | null, newObj: any) {
  const diff: Record<string, any> = {};

  if (!oldObj) {
    // everything is new
    return newObj;
  }

  for (const [key, newValue] of Object.entries(newObj)) {
    const oldValue = oldObj[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      diff[key] = newValue;
    }
  }

  return diff;
}
