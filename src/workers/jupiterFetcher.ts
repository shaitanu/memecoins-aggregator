import { http, limit } from "../lib/httpClient";
import { ingestApi } from "../lib/internalApi";

function normalizeJup(addrRaw: string, j: any) {
  // normalize address (lowercase & trimmed)
  const token_address = addrRaw?.toString()?.trim();

  if (!token_address) return null;

  const price = j?.usdPrice;
  const price_change_24h = j?.priceChange24h;

  return {
    token_address,
    price: price !== undefined ? Number(price) : undefined,
    price_change_24h: price_change_24h !== undefined ? Number(price_change_24h) : undefined,
    source: "jup",
    fetched_at: Date.now(),
  };
}

export async function fetchJupiter(addresses: string[]) {
  try {
    if (!addresses || addresses.length === 0) return;

    // Jupiter safe chunk size: 50
    const chunks: string[][] = [];
    for (let i = 0; i < addresses.length; i += 50) {
      chunks.push(addresses.slice(i, i + 50));
    }

    const chunkRequests = chunks.map((chunk) =>
      limit(() =>
        http
          .get(`https://lite-api.jup.ag/price/v3?ids=${chunk.join(",")}`)
          .then((res) => res.data)
          .catch((err) => {
            console.warn("Jupiter chunk failed:", err?.message || err);
            return null;
          })
      )
    );

    const settled = await Promise.allSettled(chunkRequests);

    const tokens: any[] = [];

    for (const s of settled) {
      if (s.status !== "fulfilled" || !s.value) continue;

      const data = s.value;
      for (const [tokenAddress, info] of Object.entries<any>(data)) {
        const n = normalizeJup(tokenAddress, info);
        if (n) tokens.push(n);
      }
    }

    if (tokens.length === 0) {
      console.log("Jupiter: no tokens normalized");
      return;
    }

    // Deduplicate by address (keep newest fetched_at)
    const latestByAddress = new Map<string, any>();
    for (const t of tokens) {
      const addr = t.token_address;
      const existing = latestByAddress.get(addr);

      if (!existing || t.fetched_at > existing.fetched_at) {
        latestByAddress.set(addr, t);
      }
    }

    const deduped = Array.from(latestByAddress.values());

    // Send final deduped batch to /ingest
    await ingestApi.post("/ingest", {
      source: "jup",
      tokens: deduped,
    });

    console.log(`Jupiter → sent ${deduped.length} tokens to /ingest`);
  } catch (err) {
    console.error("Jupiter fetch error:", err);
  }
}
