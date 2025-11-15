import dotenv from "dotenv";
dotenv.config();

import { schedulePeriodic } from "./workers/fetcherBase";
import { fetchDexScreener } from "./workers/dexscreenerFetcher";

const interval = Number(process.env.FETCH_INTERVAL || 8000);

console.log("Starting DexScreener worker...");

// Run every X milliseconds
schedulePeriodic(fetchDexScreener, interval);
