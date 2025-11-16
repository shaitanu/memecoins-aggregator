// -----------------------------------------------------------------------------
//  MERGE TOKENS (existing DB snapshot + incoming merged object)
// -----------------------------------------------------------------------------

export function mergeTokens(existing: any | null, incoming: any, source: string, fetched_at: number) {
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
//  DIFF FUNCTION
// -----------------------------------------------------------------------------


export function diffObjects(oldObj: any | null, newObj: any) {
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
// -----------------------------------------------------------------------------
//  FILTER OUT USELESS CHANGES
// -----------------------------------------------------------------------------

export function filterMeaningfulDiff(diff: any) {
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
