// gateway.js — a WebSocket connection server backed by Redis pub/sub for
// live delivery and Amazon Keyspaces (Cassandra) for durable storage,
// using the hybrid sharding design: messages_by_conversation (partitioned
// by conversation) + inbox_by_user (partitioned by user) for join-free
// catch-up. Run several instances on different ports to simulate multiple
// gateway machines behind a load balancer, all sharing one Redis broker.
// See db.js for the storage layer, auth.js for how tokens get issued.
//
// Connections authenticate with a token from auth.js (?token=<jwt>), not
// a self-reported username — see the verification block below.
//
// Usage: npm run gateway -- <port> <gatewayName>
// Example: npm run gateway -- 3001 gateway-1

import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';
import jwt from 'jsonwebtoken';
import {
  client as cassandraClient,
  conversationIdFor,
  saveMessage,
  getInboxSince,
  createGroup,
  saveGroupMessage,
  getConversationsForUser,
  ValidationError,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] || 3001;
const name = process.argv[3] || `gateway-${port}`;

// Only the public key — this process can verify tokens but never mint
// them, even if compromised. auth.js is the only holder of the private key.
const publicKey = readFileSync(join(__dirname, 'keys', 'public.pem'), 'utf-8');

function log(...args) {
  console.log(`[${name}]`, ...args);
}

async function main() {
  await cassandraClient.connect();

  const publisher = createClient();
  const subscriber = publisher.duplicate();
  await publisher.connect();
  await subscriber.connect();

  const localSockets = new Map();

  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const token = url.searchParams.get('token');
    const afterTs = Number(url.searchParams.get('afterTs')) || 0;
    const afterMessageId = url.searchParams.get('afterMessageId') || null;

    if (!token) {
      ws.close(1008, 'missing ?token=<jwt>');
      return;
    }

    let userId;
    try {
      // Pinning `algorithms` explicitly matters, not just formally — it's
      // what stops the classic "algorithm confusion" attack, where a
      // verifier that trusts whatever algorithm a token *claims* can be
      // tricked into accepting a forged token signed a different way.
      const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
      userId = decoded.sub;
    } catch (err) {
      log(`rejected connection: invalid token (${err.message})`);
      ws.close(1008, 'invalid or expired token');
      return;
    }

    log(`${userId} connected`);
    localSockets.set(userId, ws);
    const channel = `user:${userId}`;

    // Register these before any `await` below — a client can send its
    // first message the instant the connection opens, and if the listener
    // isn't attached yet, that message is silently dropped.
    ws.on('message', async (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (payload.createGroup) {
        const { name, members } = payload.createGroup;
        try {
          const { groupId, recipients, failedRecipients, noticeId, createdAt } = await createGroup({
            creatorId: userId,
            memberIds: members || [],
            name,
          });
          log(`${userId} created group ${groupId} ("${name}") with ${recipients.length} other member(s)`);
          if (failedRecipients.length > 0) {
            log(`group-created notice gap for ${groupId}: ${failedRecipients.join(', ')}`);
          }
          ws.send(JSON.stringify({ groupCreated: { groupId, name } }));

          // Let everyone else know, live if they're online right now —
          // offline members still get this via inbox catch-up, same as
          // any other message.
          const noticeEvent = JSON.stringify({
            messageId: noticeId.toString(),
            from: userId,
            toGroup: groupId,
            groupName: name,
            text: 'added you to the group',
            ts: createdAt.getTime(),
          });
          await Promise.allSettled(recipients.map((r) => publisher.publish(`user:${r}`, noticeEvent)));
        } catch (err) {
          if (err instanceof ValidationError) {
            // A fixable mistake, not a broken connection — tell the
            // client and keep the socket open.
            ws.send(JSON.stringify({ error: err.message }));
          } else {
            log(`error creating group for ${userId}:`, err.message);
            ws.close(1011, 'internal error');
          }
        }
        return;
      }

      const { to, toGroup, text } = payload;
      if (!text || (!to && !toGroup)) return;

      try {
        if (toGroup) {
          const { messageId, createdAt, recipients, failedRecipients, groupName } =
            await saveGroupMessage({ groupId: toGroup, senderId: userId, text });

          if (failedRecipients.length > 0) {
            log(`fan-out gap for group ${toGroup}: ${failedRecipients.join(', ')}`);
          }

          const event = JSON.stringify({
            messageId: messageId.toString(),
            from: userId,
            toGroup,
            groupName,
            text,
            ts: createdAt.getTime(),
          });
          log(`${userId} -> saved + publish to group ${toGroup} (${recipients.length} recipient(s))`);
          await Promise.allSettled(recipients.map((r) => publisher.publish(`user:${r}`, event)));
        } else {
          const conversationId = conversationIdFor(userId, to);
          const { messageId, createdAt } = await saveMessage({
            conversationId,
            senderId: userId,
            recipientId: to,
            text,
          });

          const event = JSON.stringify({
            messageId: messageId.toString(),
            from: userId,
            to,
            text,
            ts: createdAt.getTime(),
          });
          log(`${userId} -> saved + publish user:${to}: "${text}"`);
          await publisher.publish(`user:${to}`, event);
        }
      } catch (err) {
        if (err instanceof ValidationError) {
          ws.send(JSON.stringify({ error: err.message }));
        } else {
          log(`error handling message from ${userId}:`, err.message);
          ws.close(1011, 'internal error');
        }
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
      await subscriber.subscribe(channel, (message) => {
        log(`delivering to ${userId} (via Redis channel ${channel})`);
        ws.send(message);
      });

      // Sent once, at connect — the client maintains its own copy from
      // here, reordering/updating it locally as new message events (below)
      // arrive, rather than the server pushing a fresh list on every send.
      const conversations = await getConversationsForUser(userId);
      ws.send(JSON.stringify({
        conversations: conversations.map((row) => ({
          conversationId: row.conversation_id,
          conversationType: row.conversation_type,
          displayName: row.display_name,
          lastMessagePreview: row.last_message_preview,
          lastMessageAt: row.last_message_at.getTime(),
        })),
      }));

      // Single-partition read, no join — the payoff of sharding by
      // user_id instead of scatter-gathering across conversations.
      const missed = await getInboxSince(userId, afterTs, afterMessageId);
      if (missed.length > 0) {
        log(`replaying ${missed.length} missed message(s) to ${userId}`);
      }
      for (const row of missed) {
        const isGroup = row.conversation_type === 'group';
        ws.send(JSON.stringify({
          messageId: row.message_id.toString(),
          from: row.sender_id,
          ...(isGroup
            ? { toGroup: row.conversation_id, groupName: row.group_name }
            : { to: userId }),
          text: row.text,
          ts: row.created_at.getTime(),
        }));
      }
    } catch (err) {
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
