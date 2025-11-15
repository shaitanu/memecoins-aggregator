import { http, limit } from "../lib/httpClient";
import { ingestApi } from "../lib/internalApi";

/**
 * Normalize pair data → TokenDto
 * This function is defensive: it checks multiple possible paths for fields,
 * coerces numbers, normalizes address casing, and preserves fetched_at.
 */
function normalizeDex(entry: any) {
  // dex pair responses usually have baseToken object (the token) plus pair-level metrics
  const base = entry?.baseToken ?? entry?.base ?? entry;

  // canonical address (string) - normalize to lowercase and trim
  const rawAddr =
    base?.address ||
    entry?.tokenAddress ||
    entry?.token_address ||
    entry?.tokenAddress?.toString?.();

  const token_address = typeof rawAddr === "string" ? rawAddr.trim() : String(rawAddr || "").trim();
  const token_address_clean = token_address;


  const token_name =
    base?.name || base?.tokenName || entry?.token_name || entry?.name || undefined;

  const token_ticker =
    base?.symbol || base?.symbol?.toUpperCase?.() || entry?.token_ticker || entry?.symbol || undefined;

  // price fields - try multiple common names
  const priceRaw = entry?.priceUsd ?? entry?.price ?? entry?.lastPrice ?? base?.priceUsd ?? base?.price;
  const price = priceRaw !== undefined && priceRaw !== null ? Number(priceRaw) : undefined;

  // volume (24h) - dexscreener often provides volume.h24
  const volumeRaw = entry?.volume?.h24 ?? entry?.volume24h ?? entry?.volume ?? entry?.volumeUsd24h;
  const volume = volumeRaw !== undefined && volumeRaw !== null ? Number(volumeRaw) : undefined;

  // liquidity (USD)
  const liquidityRaw = entry?.liquidity?.usd ?? entry?.liquidityUsd ?? entry?.liquidity;
  const liquidity =
    liquidityRaw !== undefined && liquidityRaw !== null ? Number(liquidityRaw) : undefined;

  // fdv / market cap
  const mcRaw = entry?.fdv ?? entry?.marketCap ?? entry?.market_cap ?? entry?.marketcap;
  const market_cap = mcRaw !== undefined && mcRaw !== null ? Number(mcRaw) : undefined;

  const txns = entry?.txns?.h24 ?? entry?.txns ?? entry?.transactions ?? undefined;

  const pair_address = entry?.pairAddress ?? entry?.pair_address ?? undefined;
  const dex_id = entry?.dexId ?? entry?.dex_id ?? undefined;

  return {
    token_address: token_address_clean,
    token_name,
    token_ticker,
    price,
    volume,
    liquidity,
    market_cap,
    txns,
    pair_address,
    dex_id,
    source: "dex",
    fetched_at: Date.now(),
  };
}

/**
 * Fetch boosted tokens and then token details.
 * Improvements:
 * - Robust parsing of boost response
 * - Promise.allSettled for detail fetches
 * - Deduplicate tokens by address, choose best pair (by liquidity -> volume -> latest)
 * - POST final deduped normalized tokens to /ingest
 */
export async function fetchDexScreener() {
  try {
    // STEP 1 — fetch boosted tokens (list)
    const boostUrl = "https://api.dexscreener.com/token-boosts/top/v1";
    const boostRes = await http.get(boostUrl);

    // dexscreener may return array directly or wrap it; be defensive
    const boostedArray: any[] =
      Array.isArray(boostRes.data) ? boostRes.data : boostRes.data?.tokens ?? boostRes.data?.topTokens ?? [];

    if (!Array.isArray(boostedArray) || boostedArray.length === 0) {
      console.log("DexScreener: No boosted tokens found");
      console.log("Raw Boost Response:", JSON.stringify(boostRes.data)?.slice(0, 400));
      return;
    }

    // Take top 50 addresses
    const top50 = boostedArray.slice(0, 50);
    const addresses = top50.map((e: any) => e?.tokenAddress).filter(Boolean);

    console.log(`DexScreener: Boosted tokens → ${addresses.length} addresses`);

    if (addresses.length === 0) return;

    // STEP 2 — Fetch token details in limited concurrency
    const detailPromises = addresses.map((addr: string) =>
      limit(() =>
        http
          .get(`https://api.dexscreener.com/latest/dex/tokens/${addr}`)
          .then((r) => r)
          .catch((err) => {
            // swallow error, return null so Promise.allSettled can handle
            console.warn(`Dexscreener detail fetch failed for ${addr}: ${String(err)}`);
            return null;
          })
      )
    );

    const settled = await Promise.allSettled(detailPromises);
    const successfulResults: any[] = [];

    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) {
        successfulResults.push(s.value);
      }
    }

    // STEP 3 — collect SOL / SOL-quoted pairs only and normalize
    const normalizedPairs: any[] = [];

    for (const res of successfulResults) {
      const pairs = res?.data?.pairs;
      if (!Array.isArray(pairs)) continue;

      const solPairs = pairs.filter(
        (pair: any) =>
          pair?.chainId === "solana" &&
          (pair?.quoteToken?.symbol?.toUpperCase?.() === "SOL" ||
            pair?.quoteToken?.symbol === "SOL")
      );

      for (const p of solPairs) {
        const normalized = normalizeDex(p);
        if (normalized.token_address) normalizedPairs.push(normalized);
      }
    }

    if (normalizedPairs.length === 0) {
      console.log("DexScreener: no SOL pairs normalized");
      return;
    }

    // STEP 4 — deduplicate by token_address and choose best pair
    const bestByAddress = new Map<string, any>();

    for (const t of normalizedPairs) {
      const addr = t.token_address;
      if (!addr) continue;

      const existing = bestByAddress.get(addr);
      if (!existing) {
        bestByAddress.set(addr, t);
        continue;
      }

      // choose the "better" entry: prefer higher liquidity, then higher volume, then more recent
      const existingScore =
        (existing.liquidity || 0) * 1e6 + (existing.volume || 0) * 1e3 + (existing.fetched_at || 0);
      const newScore = (t.liquidity || 0) * 1e6 + (t.volume || 0) * 1e3 + (t.fetched_at || 0);

      if (newScore > existingScore) {
        bestByAddress.set(addr, t);
      }
    }

    const deduped = Array.from(bestByAddress.values());

    // STEP 5 — POST to /ingest
    await ingestApi.post("/ingest", {
      source: "dex",
      tokens: deduped,
    });

    console.log(`DexScreener: sent ${deduped.length} deduped token(s) to /ingest`);
  } catch (err) {
    console.error("DexScreener fetch error:", err);
  }
}
