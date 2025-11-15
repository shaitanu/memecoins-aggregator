import { pub } from "../lib/redis";

//
// This helper publishes raw token data to Redis Pub/Sub
//
export async function publishRaw(source: string, tokens: any[]) {
  const payload = {
    source,
    fetched_at: Date.now(),
    tokens,
  };

  await pub.publish("raw_tokens", JSON.stringify(payload));
}

//
// This helper runs a function every X milliseconds
//
export function schedulePeriodic(fn: () => Promise<void>, intervalMs: number) {
  let running = false;

  async function loop() {
    if (running) return;      // prevent double execution
    running = true;

    try {
      await fn();             // run the fetcher function
    } catch (err) {
      console.error("Fetcher error:", err);
    } finally {
      running = false;
      setTimeout(loop, intervalMs);    // schedule next run
    }
  }

  loop();  // start immediately
}
