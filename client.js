// client.js — a minimal interactive chat client for talking to a gateway.
// Usage: node client.js <yourUserId> <gatewayPort>
// Example: node client.js alice 3001
//
// Once connected:
//   bob:hello there                       send "hello there" to user "bob"
//   #<groupId>:hello everyone              send to a group by id
//   /creategroup <name> <a>,<b>,<c>        create a group (you're added automatically)

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
    console.log('Type "<recipient>:<message>", "#<groupId>:<message>", or "/creategroup <name> <a>,<b>,<c>"\n');
    rl.prompt();
  });

  ws.on('message', (raw) => {
    const payload = JSON.parse(raw.toString());

    if (payload.groupCreated) {
      const { groupId, name } = payload.groupCreated;
      console.log(`\nGroup "${name}" created — send to it with #${groupId}:your message`);
      rl.prompt();
      return;
    }

    if (payload.error) {
      console.log(`\nError: ${payload.error}`);
      rl.prompt();
      return;
    }

    const { messageId, from, text, ts, toGroup, groupName } = payload;
    lastSeenTs = ts;
    lastSeenMessageId = messageId;

    if (seenIds.has(messageId)) return;
    seenIds.add(messageId);

    const time = new Date(ts).toLocaleTimeString();
    const label = toGroup ? `[${groupName}] ${from}` : from;
    console.log(`\n[${time}] ${label}: ${text}`);
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
  if (line.startsWith('/creategroup ')) {
    const rest = line.slice('/creategroup '.length).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
      console.log('Format: /creategroup <name> <member1>,<member2>,<member3>');
      rl.prompt();
      return;
    }
    const name = rest.slice(0, spaceIdx).trim();
    const members = rest.slice(spaceIdx + 1).split(',').map((m) => m.trim()).filter(Boolean);
    ws.send(JSON.stringify({ createGroup: { name, members } }));
    rl.prompt();
    return;
  }

  const idx = line.indexOf(':');
  if (idx === -1) {
    console.log('Format: <recipient>:<message>  or  #<groupId>:<message>  or  /creategroup <name> <members>');
    rl.prompt();
    return;
  }
  const recipient = line.slice(0, idx).trim();
  const text = line.slice(idx + 1).trim();

  if (recipient.startsWith('#')) {
    ws.send(JSON.stringify({ toGroup: recipient.slice(1), text }));
  } else {
    ws.send(JSON.stringify({ to: recipient, text }));
  }
  rl.prompt();
});
