import type { FastifyPluginAsync } from "fastify";
import type { RawData, WebSocket } from "ws";

/**
 * WebSocket gateway for live RouteStatus updates.
 *
 * Protocol (MVP):
 *   client -> server : { "type": "subscribe", "routeIds": ["uuid", ...] }
 *   client -> server : { "type": "unsubscribe", "routeIds": ["uuid", ...] }
 *   server -> client : { "type": "status", "routeId": "uuid", "status": "...", "confidence": 0.7, ... }
 *   server -> client : { "type": "pong" }  // in response to "ping"
 *
 * The aggregator worker calls `broadcastRouteStatus()` after upserting
 * route_status. For MVP this is a single-process in-memory pub/sub; we'll
 * swap to Redis Pub/Sub when we run more than one API node.
 */

type Subscriber = {
  socket: WebSocket;
  routes: Set<string>;
};

const subscribers = new Set<Subscriber>();

export interface RouteStatusEvent {
  type: "status";
  routeId: string;
  status: string;
  confidence: number;
  reportCount: number;
  lastReportAt: string | null;
}

export function broadcastRouteStatus(event: RouteStatusEvent): void {
  const payload = JSON.stringify(event);
  for (const sub of subscribers) {
    if (sub.routes.has(event.routeId) && sub.socket.readyState === sub.socket.OPEN) {
      sub.socket.send(payload);
    }
  }
}

export const wsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ws", { websocket: true }, (socket, req) => {
    const sub: Subscriber = { socket, routes: new Set() };
    subscribers.add(sub);

    const log = req.log.child({ ws: true });
    log.debug("ws connected");

    socket.on("message", (raw: RawData) => {
      let msg: { type?: string; routeIds?: string[] } | undefined;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "invalid json" }));
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "subscribe":
          if (Array.isArray(msg.routeIds)) {
            for (const id of msg.routeIds) sub.routes.add(id);
          }
          socket.send(JSON.stringify({ type: "subscribed", count: sub.routes.size }));
          break;
        case "unsubscribe":
          if (Array.isArray(msg.routeIds)) {
            for (const id of msg.routeIds) sub.routes.delete(id);
          }
          socket.send(JSON.stringify({ type: "unsubscribed", count: sub.routes.size }));
          break;
        case "ping":
          socket.send(JSON.stringify({ type: "pong" }));
          break;
        default:
          socket.send(JSON.stringify({ type: "error", message: "unknown type" }));
      }
    });

    socket.on("close", () => {
      subscribers.delete(sub);
      log.debug("ws closed");
    });

    socket.on("error", (err: Error) => {
      log.warn({ err }, "ws error");
    });
  });
};
