// gateway.js — a minimal WebSocket connection server backed by Redis pub/sub.
// Run several instances on different ports to simulate multiple gateway
// machines sitting behind a load balancer, all sharing one Redis broker.
//
// Usage: node gateway.js <port> <gatewayName>
// Example: node gateway.js 3001 gateway-1

import http from 'http';
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';

const port = process.argv[2] || 3001;
const name = process.argv[3] || `gateway-${port}`;

function log(...args) {
  console.log(`[${name}]`, ...args);
}

async function main() {
  // Redis requires a dedicated connection for subscribing — a client in
  // subscribe mode can't also run other commands — so we keep two:
  // one for publishing, one for subscribing.
  const publisher = createClient();
  const subscriber = publisher.duplicate();
  await publisher.connect();
  await subscriber.connect();

  // userId -> WebSocket, for whichever users are connected to THIS gateway.
  const localSockets = new Map();

  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const userId = url.searchParams.get('user');

    if (!userId) {
      ws.close(1008, 'missing ?user=<id>');
      return;
    }

    log(`${userId} connected`);
    localSockets.set(userId, ws);

    // Subscribe to this user's personal channel. Any gateway anywhere can
    // now deliver to this user by publishing to "user:<userId>" — it never
    // needs to know which physical gateway they're actually connected to.
    const channel = `user:${userId}`;
    await subscriber.subscribe(channel, (message) => {
      log(`delivering to ${userId} (via Redis channel ${channel})`);
      ws.send(message);
    });

    ws.on('message', async (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { to, text } = payload;
      if (!to || !text) return;

      const event = JSON.stringify({ from: userId, to, text, ts: Date.now() });
      log(`${userId} -> publish user:${to}: "${text}"`);
      await publisher.publish(`user:${to}`, event);
    });

    ws.on('close', async () => {
      log(`${userId} disconnected`);
      localSockets.delete(userId);
      await subscriber.unsubscribe(channel);
    });
  });

  server.listen(port, () => {
    log(`listening on ws://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
