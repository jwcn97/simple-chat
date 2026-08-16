// client.js — a minimal interactive chat client for talking to a gateway.
// Usage: node client.js <yourUserId> <gatewayPort>
// Example: node client.js alice 3001
//
// Once connected, type lines like:  bob:hello there
// to send "hello there" to user "bob".
//
// Works against either gateway.js (Postgres, numeric `id` cursor) or
// gateway-cassandra.js (Cassandra, composite `ts` + `messageId` cursor,
// since a UUID has no numeric max) — whichever fields a given gateway
// doesn't use are simply left at their defaults and ignored.

import readline from 'readline';
import WebSocket from 'ws';

const userId = process.argv[2];
const port = process.argv[3];

if (!userId || !port) {
  console.error('Usage: node client.js <yourUserId> <gatewayPort>');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Postgres-style cursor: a single monotonic integer id.
let lastSeenId = 0;
// Cassandra-style cursor: a (timestamp, uuid) pair, matching the
// clustering key — a plain number can't stand in for a UUID.
let lastSeenTs = 0;
let lastSeenMessageId = null;

let ws;

// Holds either numeric ids or UUID strings depending on which gateway
// this session is talking to.
const seenKeys = new Set();

function connect() {
  const params = new URLSearchParams({ user: userId, afterId: String(lastSeenId) });
  if (lastSeenMessageId) {
    params.set('afterTs', String(lastSeenTs));
    params.set('afterMessageId', lastSeenMessageId);
  }
  ws = new WebSocket(`ws://localhost:${port}?${params}`);

  ws.on('open', () => {
    console.log(`Connected as "${userId}" to gateway on port ${port}.`);
    console.log('Type "<recipient>:<message>" and press enter, e.g.  bob:hey there\n');
    rl.prompt();
  });

  ws.on('message', (raw) => {
    const payload = JSON.parse(raw.toString());
    const { from, text, ts } = payload;

    if (payload.id !== undefined) lastSeenId = Math.max(lastSeenId, payload.id);
    if (payload.messageId !== undefined) {
      lastSeenTs = ts;
      lastSeenMessageId = payload.messageId;
    }

    const dedupeKey = payload.messageId ?? payload.id;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);

    const time = new Date(ts).toLocaleTimeString();
    console.log(`\n[${time}] ${from}: ${text}`);
    rl.prompt();
  });

  ws.on('close', () => {
    console.log('\nDisconnected. Reconnecting in 1.5s...');
    setTimeout(connect, 1500);
  });

  ws.on('error', () => {
    // 'close' follows right after — the retry there covers it.
  });
}

connect();

rl.on('line', (line) => {
  const idx = line.indexOf(':');
  if (idx === -1) {
    console.log('Format: <recipient>:<message>');
    rl.prompt();
    return;
  }
  const to = line.slice(0, idx).trim();
  const text = line.slice(idx + 1).trim();
  ws.send(JSON.stringify({ to, text }));
  rl.prompt();
});
