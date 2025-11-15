import { redis } from "../../lib/redis";

export async function discoverRoute(app: any) {
  app.get("/discover", async (req: any, reply: any) => {
    const sort = String(req.query.sort || "volume");
    const limit = Number(req.query.limit || 20);
    const cursor = Number(req.query.cursor || 0);

    const indexKey = {
      volume: "index:volume",
      liquidity: "index:liquidity",
      market_cap: "index:market_cap",
      price_change_24h: "index:price_change_24h",
    }[sort];

    if (!indexKey) {
      return reply.code(400).send({ error: "Invalid sort parameter" });
    }

    // ZREVRANGE gives highest-score-first items
    const addresses = await redis.zrevrange(
      indexKey,
      cursor,
      cursor + limit - 1
    );

    const tokens: any[] = [];

    for (const address of addresses) {
      const data = await redis.hgetall(`token:${address}`);
      const parsed: any = {};

      for (const [k, v] of Object.entries(data)) {
        try {
          parsed[k] = JSON.parse(v);
        } catch {
          parsed[k] = v;
        }
      }

      tokens.push(parsed);
    }

    return {
      tokens,
      nextCursor: cursor + limit,
    };
  });
}
