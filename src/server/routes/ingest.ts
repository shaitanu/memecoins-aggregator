// src/server/routes/ingest.ts

import { pub } from "../../lib/redis";

// -------------------------------
// Buffer structures
// -------------------------------
interface TokenMap {
  [address: string]: {
    sources: Record<string, any>;
  };
}

const buffer: TokenMap = {};
let flushScheduled = false;

// -------------------------------------------------------
// MERGE LOGIC
// -------------------------------------------------------
function mergeSources(address: string, sources: Record<string, any>) {
  const dex = sources.dex;
  const jup = sources.jup;

  const result: any = {
    token_address: address,
    sources_used: Object.keys(sources),
    ingested_at: Date.now(),
  };

  // ---------------------------------------
  // Name & Ticker
  // ---------------------------------------
  if (dex) {
    result.token_name = dex.token_name || dex.name;
    result.token_ticker = dex.token_ticker || dex.symbol;
  }

  // ---------------------------------------
  // Price
  // PRIORITY: Jupiter → DexScreener
  // ---------------------------------------
  if (jup && jup.price !== undefined) {
    result.price = Number(jup.price);
  } else if (dex && dex.price !== undefined) {
    result.price = Number(dex.price);
  }

  // ---------------------------------------
  // Volume (DexScreener only)
  // ---------------------------------------
  if (dex && dex.volume !== undefined) {
    result.volume = Number(dex.volume);
  }

  // ---------------------------------------
  // Liquidity (DexScreener)
  // ---------------------------------------
  if (dex && dex.liquidity !== undefined) {
    result.liquidity = Number(dex.liquidity);
  }

  // ---------------------------------------
  // Price change (Jupiter)
  // ---------------------------------------
  if (jup && jup.price_change_24h !== undefined) {
    result.price_change_24h = Number(jup.price_change_24h);
  }

  return result;
}

// -------------------------------------------------------
// FLUSH to aggregator
// -------------------------------------------------------
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;

  setTimeout(async () => {
    flushScheduled = false;

    const mergedBatch: any[] = [];

    for (const [addr, obj] of Object.entries(buffer)) {
      const merged = mergeSources(addr, obj.sources);
      mergedBatch.push(merged);
    }

    // Clear buffer
    for (const k in buffer) delete buffer[k];

    if (mergedBatch.length > 0) {
      console.log(`🟢 /ingest → merged batch: ${mergedBatch.length} tokens`);
      console.log(JSON.stringify(mergedBatch, null, 2));

      // Publish unified batch to aggregator
      await pub.publish(
        "raw_tokens",
        JSON.stringify({ tokens: mergedBatch, ingested_at: Date.now() })
      );
    }

  }, 150);
}

// -------------------------------------------------------
// /ingest route
// -------------------------------------------------------
export async function ingestRoute(app: any) {
  app.post("/ingest", async (req: any, reply: any) => {
    try {
      const { source, tokens } = req.body || {};

      if (!source || !Array.isArray(tokens)) {
        return reply.code(400).send({
          error: "Invalid payload. Expected { source, tokens[] }",
        });
      }

      // Add to buffer grouped by token address
      for (const t of tokens) {
        const addr = t.token_address;
        if (!addr) continue;

        if (!buffer[addr]) buffer[addr] = { sources: {} };
        buffer[addr].sources[source] = t;
      }

      scheduleFlush();
      return reply.send({ status: "ok" });

    } catch (err) {
      console.error("/ingest error:", err);
      return reply.code(500).send({ error: "server_error" });
    }
  });
}
