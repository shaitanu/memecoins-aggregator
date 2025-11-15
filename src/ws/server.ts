import { WebSocketServer, WebSocket } from "ws";
import { sub } from "../lib/redis";

export function createWebSocketServer() {
  const wss = new WebSocketServer({ port: 4000 });

  console.log("WebSocket server running on ws://localhost:4000");

  // Subscribe to state changes from aggregator
  sub.subscribe("state_changes");

  sub.on("message", (_channel: string, message: string) => {
    // Broadcast to all connected clients
    wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  wss.on("connection", (socket: WebSocket) => {
    console.log("Client connected");

    socket.send(
      JSON.stringify({
        type: "welcome",
        msg: "Connected to WS server",
      })
    );
  });

  return wss;
}
