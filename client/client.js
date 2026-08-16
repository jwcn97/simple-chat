// client.js — a minimal interactive chat client for talking to a gateway.
// Usage: npm run client -- <username> <password> <gatewayPort> [--signup]
// Example: npm run client -- alice hunter2 3001 --signup
//
// Logs in against auth.js (creating the account first if --signup is
// given) before ever touching the gateway — the gateway only accepts a
// signed token now, not a self-reported username.
//
// Once connected:
//   bob:hello there                       send "hello there" to user "bob"
//   #<groupId>:hello everyone              send to a group by id
//   /creategroup <name> <a>,<b>,<c>        create a group (you're added automatically)

import readline from 'readline';
import WebSocket from 'ws';

const username = process.argv[2];
const password = process.argv[3];
const port = process.argv[4];
const shouldSignup = process.argv.includes('--signup');
const authUrl = process.env.AUTH_URL || 'http://localhost:4000';

if (!username || !password || !port) {
  console.error('Usage: node client.js <username> <password> <gatewayPort> [--signup]');
  process.exit(1);
}

async function authFetch(path, body) {
  const res = await fetch(`${authUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `auth request failed (${res.status})`);
  }
  return data;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// The cursor for catch-up: a (timestamp, message id) pair, matching the
// table's clustering key exactly — message_id is a UUID, so a plain
// numeric cursor can't represent it.
let lastSeenTs = 0;
let lastSeenMessageId = null;

let ws;
const seenIds = new Set();

async function connect() {
  let token;
  try {
    // Re-login on every (re)connect, not just once at startup — tokens
    // expire, and this way a stale one self-heals on the next reconnect
    // instead of retrying forever with something the gateway will keep
    // rejecting.
    ({ token } = await authFetch('/login', { username, password }));
  } catch (err) {
    console.error(`Login failed: ${err.message}. Retrying in 1.5s...`);
    setTimeout(connect, 1500);
    return;
  }

  const params = new URLSearchParams({ token });
  if (lastSeenMessageId) {
    params.set('afterTs', String(lastSeenTs));
    params.set('afterMessageId', lastSeenMessageId);
  }
  ws = new WebSocket(`ws://localhost:${port}?${params}`);

  ws.on('open', () => {
    console.log(`Connected as "${username}" to gateway on port ${port}.`);
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

async function main() {
  if (shouldSignup) {
    try {
      await authFetch('/signup', { username, password });
      console.log(`Account "${username}" created.`);
    } catch (err) {
      console.error(`Signup failed: ${err.message}`);
      process.exit(1);
    }
  }
  connect();
}

main();

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
