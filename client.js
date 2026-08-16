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

// The cursor for catch-up: a (timestamp, message id) pair, matching the
// table's clustering key exactly — message_id is a UUID, so a plain
// numeric cursor can't represent it.
let lastSeenTs = 0;
let lastSeenMessageId = null;

let ws;
const seenIds = new Set();

function connect() {
  const params = new URLSearchParams({ user: userId });
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
    const { messageId, from, text, ts } = JSON.parse(raw.toString());
    lastSeenTs = ts;
    lastSeenMessageId = messageId;

    if (seenIds.has(messageId)) return;
    seenIds.add(messageId);

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
