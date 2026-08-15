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

const ws = new WebSocket(`ws://localhost:${port}?user=${userId}`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

ws.on('open', () => {
  console.log(`Connected as "${userId}" to gateway on port ${port}.`);
  console.log('Type "<recipient>:<message>" and press enter, e.g.  bob:hey there\n');
  rl.prompt();
});

ws.on('message', (raw) => {
  const { from, text, ts } = JSON.parse(raw.toString());
  const time = new Date(ts).toLocaleTimeString();
  console.log(`\n[${time}] ${from}: ${text}`);
  rl.prompt();
});

ws.on('close', () => {
  console.log('\nDisconnected.');
  process.exit(0);
});

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
