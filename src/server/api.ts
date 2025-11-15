import Fastify from "fastify";
import fastifyCors from "@fastify/cors";

import { discoverRoute } from "./routes/discover";
import { health } from "./routes/health";

export async function createApiServer() {
  const app = Fastify({
    logger: true,
  });

  // ------------------------------
  // Enable CORS for frontend access
  // ------------------------------
  await app.register(fastifyCors, {
    origin: "*", // allow all origins
  });

  // ------------------------------
  // Register your routes
  // ------------------------------
  app.register(discoverRoute);
  app.register(health);

  return app;
}
