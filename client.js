// client.js — a minimal interactive chat client for talking to a gateway.
// Usage: node client.js <yourUserId> <gatewayPort>
// Example: node client.js alice 3001
//
// Once connected, type lines like:  bob:hello there
// to send "hello there" to user "bob".

import readline from 'readline';
import WebSocket from 'ws';

const userId = process.argv[2];
const port = process.argv[3];

if (!userId || !port) {
  console.error('Usage: node client.js <yourUserId> <gatewayPort>');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// The cursor for catch-up: every reconnect asks the gateway for anything
// after this id, so a dropped connection never loses a message — it just
// arrives a little late, replayed from the database. An id has no
// precision to lose the way a millisecond timestamp round-tripped through
// Postgres's microsecond-precision columns would.
let lastSeenId = 0;
let ws;

// The gateway subscribes before it queries history, which closes the
// "message lost" gap but opens a much smaller "message delivered twice"
// one instead — safe, as long as we dedupe by id here.
const seenIds = new Set();

function connect() {
  ws = new WebSocket(`ws://localhost:${port}?user=${userId}&afterId=${lastSeenId}`);

  ws.on('open', () => {
    console.log(`Connected as "${userId}" to gateway on port ${port}.`);
    console.log('Type "<recipient>:<message>" and press enter, e.g.  bob:hey there\n');
    rl.prompt();
  });

  ws.on('message', (raw) => {
    const { id, from, text, ts } = JSON.parse(raw.toString());
    lastSeenId = Math.max(lastSeenId, id);
    if (seenIds.has(id)) return;
    seenIds.add(id);
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
