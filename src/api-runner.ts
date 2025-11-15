import { createApiServer } from "./server/api";

const app = createApiServer();

app.listen({ port: 3000 }).then(() => {
  console.log("API server running at http://localhost:3000");
});
