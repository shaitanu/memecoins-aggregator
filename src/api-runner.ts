import { createApiServer } from "./server/api";

async function start() {
  const app = await createApiServer();

  await app.listen({ port: 3000 });
  console.log("API server running at http://localhost:3000");
}

start();
