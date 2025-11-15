import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

// Main Redis connection
export const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

// Publisher connection
export const pub = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

// Subscriber connection
export const sub = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
