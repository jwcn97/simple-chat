import cassandra from 'cassandra-driver';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const contactPoint = process.env.KEYSPACES_ENDPOINT || 'cassandra.ap-southeast-1.amazonaws.com';
const region = process.env.AWS_REGION || 'ap-southeast-1';

const sslOptions = {
  ca: [readFileSync(join(__dirname, 'keyspaces', 'keyspaces-bundle.pem'), 'utf-8')],
  host: contactPoint,
  rejectUnauthorized: true,
};

const authProvider = new cassandra.auth.PlainTextAuthProvider(
  process.env.KEYSPACES_USERNAME,
  process.env.KEYSPACES_PASSWORD
);

export const client = new cassandra.Client({
  contactPoints: [contactPoint],
  localDataCenter: region,
  keyspace: 'chat_learning',
  authProvider,
  sslOptions,
  protocolOptions: { port: 9142 },
  // Amazon Keyspaces only supports LOCAL_QUORUM (the driver's own default,
  // LOCAL_ONE, isn't accepted) — confirmed directly by the server's error
  // message rather than assumed.
  queryOptions: { consistency: cassandra.types.consistencies.localQuorum },
});

// Deterministic so either participant computes the same conversation id
// independently, with no lookup required to find "the" conversation
// between two given users.
export function conversationIdFor(userA, userB) {
  return [userA, userB].sort().join('|');
}

// Fan-out-on-write: one send becomes two inserts — the conversation's own
// timeline (messages_by_conversation) and a copy in the recipient's inbox
// (inbox_by_user) for join-free catch-up across every conversation they're
// in. No cross-table transaction; the write is durable the instant it
// succeeds, everything downstream (the pub/sub nudge) is best-effort.
export async function saveMessage({ conversationId, senderId, recipientId, text }) {
  const messageId = cassandra.types.Uuid.random();
  const createdAt = new Date();

  await client.execute(
    `INSERT INTO messages_by_conversation (conversation_id, created_at, message_id, sender_id, text)
     VALUES (?, ?, ?, ?, ?)`,
    [conversationId, createdAt, messageId, senderId, text],
    { prepare: true }
  );

  await client.execute(
    `INSERT INTO inbox_by_user (user_id, created_at, message_id, conversation_id, sender_id, text)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [recipientId, createdAt, messageId, conversationId, senderId, text],
    { prepare: true }
  );

  return { messageId, createdAt };
}

// Catch-up: a single-partition read against inbox_by_user, no join across
// conversations required — the payoff of sharding by user_id. inbox_by_user
// only ever gets a row for the recipient, never the sender, so there's no
// need to filter out the user's own messages — the fan-out write already
// encodes exactly what should come back.
//
// The table's declared clustering order is (created_at DESC, message_id
// ASC); a SELECT may only use that order or its exact full reversal, so
// oldest-first here means ORDER BY created_at ASC, message_id DESC.
//
// Vanilla Cassandra would express "anything after this (created_at,
// message_id) point" as a single multi-column relation — confirmed by
// Amazon Keyspaces itself that it doesn't support that syntax ("MultiColumn
// relation is not yet supported"). Decomposed into two single-column-
// relation queries instead: rows tied at the exact cursor millisecond but
// with a "later" message_id, plus rows from any strictly later millisecond
// — concatenated in that order, which is already correctly sorted since
// every row in the first query sorts before every row in the second.
export async function getInboxSince(userId, afterTs, afterMessageId) {
  if (!afterMessageId) {
    const result = await client.execute(
      `SELECT message_id, sender_id, text, created_at
       FROM inbox_by_user
       WHERE user_id = ?
       ORDER BY created_at ASC, message_id DESC
       LIMIT 100`,
      [userId],
      { prepare: true }
    );
    return result.rows;
  }

  const cursorDate = new Date(afterTs);
  const cursorId = cassandra.types.Uuid.fromString(afterMessageId);

  const [tied, later] = await Promise.all([
    client.execute(
      `SELECT message_id, sender_id, text, created_at
       FROM inbox_by_user
       WHERE user_id = ? AND created_at = ? AND message_id > ?
       LIMIT 100`,
      [userId, cursorDate, cursorId],
      { prepare: true }
    ),
    client.execute(
      `SELECT message_id, sender_id, text, created_at
       FROM inbox_by_user
       WHERE user_id = ? AND created_at > ?
       ORDER BY created_at ASC, message_id DESC
       LIMIT 100`,
      [userId, cursorDate],
      { prepare: true }
    ),
  ]);

  return [...tied.rows, ...later.rows].slice(0, 100);
}
