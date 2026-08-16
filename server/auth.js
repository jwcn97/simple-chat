// auth.js — standalone HTTP service that owns the private JWT signing
// key. It's the only thing that can mint tokens; gateway.js only ever
// holds the public key, so it can verify tokens but never forge them.
//
// Usage: npm run auth
// Endpoints:
//   POST /signup { username, password } -> { ok: true }
//   POST /login  { username, password } -> { token }

import http from 'http';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { client, createUser, findUserByUsername, ValidationError } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = process.env.AUTH_PORT || 4000;

const privateKey = readFileSync(join(__dirname, 'keys', 'private.pem'), 'utf-8');

// OWASP's current Argon2id baseline (Password Storage Cheat Sheet).
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function main() {
  await client.connect();

  // Precomputed once so /login can verify against *something* even when
  // the username doesn't exist — otherwise a nonexistent-user login
  // would skip the (slow) hash verification entirely, and the timing
  // difference would leak which usernames are actually registered.
  const dummyHash = await argon2.hash('not-a-real-account', ARGON2_OPTIONS);

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    const { username, password } = body;
    if (!username || !password) {
      sendJson(res, 400, { error: 'username and password are required' });
      return;
    }

    if (req.url === '/signup') {
      try {
        const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
        await createUser({ username, passwordHash });
        console.log(`[auth] signed up "${username}"`);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        if (err instanceof ValidationError) {
          sendJson(res, 409, { error: err.message });
        } else {
          console.error('[auth] signup error:', err.message);
          sendJson(res, 500, { error: 'internal error' });
        }
      }
      return;
    }

    if (req.url === '/login') {
      try {
        const user = await findUserByUsername(username);
        const valid = await argon2.verify(user ? user.password_hash : dummyHash, password);
        if (!user || !valid) {
          sendJson(res, 401, { error: 'invalid username or password' });
          return;
        }
        const token = jwt.sign({ sub: username }, privateKey, {
          algorithm: 'RS256',
          expiresIn: '24h',
        });
        console.log(`[auth] logged in "${username}"`);
        sendJson(res, 200, { token });
      } catch (err) {
        console.error('[auth] login error:', err.message);
        sendJson(res, 500, { error: 'internal error' });
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  server.listen(port, () => {
    console.log(`[auth] listening on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
