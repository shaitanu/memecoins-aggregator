export {};

import { http, limit } from "../lib/httpClient";
import { publishRaw } from "./fetcherBase";

// A simple normalizer to convert DexScreener data → TokenDto structure
function normalizeDex(entry: any) {
  return {
    token_address: entry?.baseToken?.address || entry?.tokenAddress,
    token_name: entry?.baseToken?.name,
    token_ticker: entry?.baseToken?.symbol,

    price_sol: Number(entry?.priceUsd) || undefined,
    volume_sol: Number(entry?.volume?.h24) || undefined,
    liquidity_sol: Number(entry?.liquidity?.usd) || undefined,

    source: "dexscreener",
    fetched_at: Date.now(),
  };
}

export async function fetchDexScreener() {
  // Example: fetch SOL trending pairs
  const url = "https://api.dexscreener.com/latest/dex/search?q=SOL/USDC";

  // Use concurrency limiter (good habit)
  const res = await limit(() => http.get(url));

  const pairs = res.data?.pairs || [];

  const normalized = pairs.map(normalizeDex);

  // Publish to Redis Pub/Sub
  await publishRaw("dexscreener", normalized);

  console.log("Fetched from Dexscreener:", normalized.length, "tokens");
}
