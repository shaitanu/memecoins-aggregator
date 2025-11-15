import Fastify from "fastify";
import { discoverRoute } from "./routes/discover";

export function createApiServer() {
  const app = Fastify({
    logger: true,
  });

  app.register(discoverRoute);

  return app;
}
