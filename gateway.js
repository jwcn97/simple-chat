// gateway.js — a minimal WebSocket connection server backed by Redis pub/sub.
// Run several instances on different ports to simulate multiple gateway
// machines sitting behind a load balancer, all sharing one Redis broker.
//
// Usage: node gateway.js <port> <gatewayName>
// Example: node gateway.js 3001 gateway-1

import http from 'http';
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';
import { pool, conversationIdFor } from './db.js';

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
    const since = Number(url.searchParams.get('since')) || 0;

    if (!userId) {
      ws.close(1008, 'missing ?user=<id>');
      return;
    }

    log(`${userId} connected`);
    localSockets.set(userId, ws);
    const channel = `user:${userId}`;

    // Register these two handlers synchronously, before anything below
    // that `await`s. A client can send its first message the instant the
    // connection opens — if we only attach the listener after an `await`
    // (e.g. the catch-up query below), that message can arrive and be
    // silently dropped in the gap before we were actually listening.
    ws.on('message', async (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { to, text } = payload;
      if (!to || !text) return;

      const conversationId = conversationIdFor(userId, to);

      // Durability first: this write has to succeed before we do anything
      // else. Once it does, the message can never be lost, no matter what
      // happens to Redis, this gateway, or the recipient's connection.
      await pool.query(
        `INSERT INTO conversations (id, user_a_id, user_b_id, last_message_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET last_message_at = now()`,
        [conversationId, userId, to]
      );
      const { rows: [inserted] } = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, text)
         VALUES ($1, $2, $3)
         RETURNING created_at`,
        [conversationId, userId, text]
      );

      // Only now do we publish — a best-effort nudge for whoever's online
      // right now, not the source of truth.
      const event = JSON.stringify({
        from: userId,
        to,
        text,
        ts: inserted.created_at.getTime(),
      });
      log(`${userId} -> saved + publish user:${to}: "${text}"`);
      await publisher.publish(`user:${to}`, event);
    });

    ws.on('close', async () => {
      log(`${userId} disconnected`);
      localSockets.delete(userId);
      await subscriber.unsubscribe(channel);
    });

    // Catch-up: replay anything sent to this user while they were away.
    // Pub/sub is fire-and-forget, so this is what actually makes delivery
    // reliable — the database was written *before* any publish happened,
    // so nothing sent while this user was offline was ever lost.
    const missed = await pool.query(
      `SELECT m.sender_id, m.text, m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
         AND m.sender_id != $1
         AND m.created_at > to_timestamp($2 / 1000.0)
       ORDER BY m.created_at ASC
       LIMIT 100`,
      [userId, since]
    );
    if (missed.rows.length > 0) {
      log(`replaying ${missed.rows.length} missed message(s) to ${userId}`);
    }
    for (const row of missed.rows) {
      ws.send(JSON.stringify({
        from: row.sender_id,
        to: userId,
        text: row.text,
        ts: row.created_at.getTime(),
      }));
    }

    // Subscribe to this user's personal channel. Any gateway anywhere can
    // now deliver to this user by publishing to "user:<userId>" — it never
    // needs to know which physical gateway they're actually connected to.
    await subscriber.subscribe(channel, (message) => {
      log(`delivering to ${userId} (via Redis channel ${channel})`);
      ws.send(message);
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
