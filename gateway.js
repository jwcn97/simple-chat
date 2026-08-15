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
    const afterId = Number(url.searchParams.get('afterId')) || 0;

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

      try {
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
           RETURNING id, created_at`,
          [conversationId, userId, text]
        );

        // Only now do we publish — a best-effort nudge for whoever's online
        // right now, not the source of truth.
        const event = JSON.stringify({
          id: inserted.id,
          from: userId,
          to,
          text,
          ts: inserted.created_at.getTime(),
        });
        log(`${userId} -> saved + publish user:${to}: "${text}"`);
        await publisher.publish(`user:${to}`, event);
      } catch (err) {
        // Same reasoning as the try/catch below: an uncaught error here
        // would otherwise crash the whole gateway, not just this message.
        log(`error handling message from ${userId}:`, err.message);
        ws.close(1011, 'internal error');
      }
    });

    ws.on('close', async () => {
      log(`${userId} disconnected`);
      localSockets.delete(userId);
      try {
        await subscriber.unsubscribe(channel);
      } catch (err) {
        log(`error unsubscribing ${userId}:`, err.message);
      }
    });

    try {
      // Subscribe before catch-up so a message published in between can
      // only ever be delivered twice (deduped by id in client.js), never lost.
      await subscriber.subscribe(channel, (message) => {
        log(`delivering to ${userId} (via Redis channel ${channel})`);
        ws.send(message);
      });

      // Catch-up: replay anything sent to this user while they were away.
      const missed = await pool.query(
        `SELECT m.id, m.sender_id, m.text, m.created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
           AND m.sender_id != $1
           AND m.id > $2
         ORDER BY m.id ASC
         LIMIT 100`,
        [userId, afterId]
      );
      if (missed.rows.length > 0) {
        log(`replaying ${missed.rows.length} missed message(s) to ${userId}`);
      }
      for (const row of missed.rows) {
        ws.send(JSON.stringify({
          id: row.id,
          from: row.sender_id,
          to: userId,
          text: row.text,
          ts: row.created_at.getTime(),
        }));
      }
    } catch (err) {
      // Without a catch here, a failed query/subscribe is an unhandled
      // rejection — which crashes this whole process, not just this one
      // connection, taking every other user on this gateway down with it.
      log(`error setting up ${userId}:`, err.message);
      ws.close(1011, 'internal error');
    }
  });

  server.listen(port, () => {
    log(`listening on ws://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
