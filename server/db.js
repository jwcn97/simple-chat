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

// Distinguishes "the user made a fixable mistake" (e.g. too few members)
// from "something actually broke" — gateway.js uses this to decide
// whether to send an error and keep the connection open, or close it.
export class ValidationError extends Error {}

// Fan-out-on-write: one send becomes two inserts — the conversation's own
// timeline (messages_by_conversation) and a copy in the recipient's inbox
// (inbox_by_user) for join-free catch-up across every conversation they're
// in. No cross-table transaction; the write is durable the instant it
// succeeds, everything downstream (the pub/sub nudge) is best-effort.
export async function saveMessage({ conversationId, senderId, recipientId, text }) {
  const messageId = cassandra.types.Uuid.random();
  const createdAt = new Date();

  await client.execute(
    `INSERT INTO messages_by_conversation
       (conversation_id, created_at, message_id, sender_id, text, conversation_type)
     VALUES (?, ?, ?, ?, ?, 'direct')`,
    [conversationId, createdAt, messageId, senderId, text],
    { prepare: true }
  );

  await client.execute(
    `INSERT INTO inbox_by_user
       (user_id, created_at, message_id, conversation_id, sender_id, text, conversation_type)
     VALUES (?, ?, ?, ?, ?, ?, 'direct')`,
    [recipientId, createdAt, messageId, conversationId, senderId, text],
    { prepare: true }
  );

  return { messageId, createdAt };
}

export async function createGroup({ creatorId, memberIds, name }) {
  const members = [...new Set([creatorId, ...memberIds])];
  if (members.length < 3) {
    throw new ValidationError('a group needs at least 3 members');
  }

  const groupId = cassandra.types.Uuid.random().toString();
  const createdAt = new Date();

  await client.execute(
    `INSERT INTO groups (group_id, name, creator_id, created_at) VALUES (?, ?, ?, ?)`,
    [groupId, name, creatorId, createdAt],
    { prepare: true }
  );

  // Unlike message fan-out below, membership writes use Promise.all, not
  // allSettled: a group missing one of its members is a real correctness
  // gap (someone silently left out), not the accepted best-effort case.
  await Promise.all(members.map((userId) =>
    client.execute(
      `INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`,
      [groupId, userId],
      { prepare: true }
    )
  ));

  return { groupId, name, members };
}

export async function getGroupMembers(groupId) {
  const result = await client.execute(
    `SELECT user_id FROM group_members WHERE group_id = ?`,
    [groupId],
    { prepare: true }
  );
  return result.rows.map((r) => r.user_id);
}

// Fan-out-on-write to every group member except the sender. Per the
// Stage 1 decision, this is independent and best-effort per recipient —
// Promise.allSettled (not all) so one recipient's failed inbox write
// doesn't make the whole send look like it failed when it mostly worked.
export async function saveGroupMessage({ groupId, senderId, text }) {
  const messageId = cassandra.types.Uuid.random();
  const createdAt = new Date();

  const groupRow = await client.execute(
    `SELECT name FROM groups WHERE group_id = ?`,
    [groupId],
    { prepare: true }
  );
  if (groupRow.rowLength === 0) {
    throw new ValidationError(`group ${groupId} does not exist`);
  }
  const groupName = groupRow.first().name;

  const members = await getGroupMembers(groupId);
  const recipients = members.filter((id) => id !== senderId);

  await client.execute(
    `INSERT INTO messages_by_conversation
       (conversation_id, created_at, message_id, sender_id, text, conversation_type, group_name)
     VALUES (?, ?, ?, ?, ?, 'group', ?)`,
    [groupId, createdAt, messageId, senderId, text, groupName],
    { prepare: true }
  );

  const results = await Promise.allSettled(recipients.map((recipientId) =>
    client.execute(
      `INSERT INTO inbox_by_user
         (user_id, created_at, message_id, conversation_id, sender_id, text, conversation_type, group_name)
       VALUES (?, ?, ?, ?, ?, ?, 'group', ?)`,
      [recipientId, createdAt, messageId, groupId, senderId, text, groupName],
      { prepare: true }
    )
  ));
  const failedRecipients = recipients.filter((_, i) => results[i].status === 'rejected');

  return { messageId, createdAt, recipients, failedRecipients, groupName };
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
      `SELECT message_id, sender_id, text, created_at, conversation_id, conversation_type, group_name
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
      `SELECT message_id, sender_id, text, created_at, conversation_id, conversation_type, group_name
       FROM inbox_by_user
       WHERE user_id = ? AND created_at = ? AND message_id > ?
       LIMIT 100`,
      [userId, cursorDate, cursorId],
      { prepare: true }
    ),
    client.execute(
      `SELECT message_id, sender_id, text, created_at, conversation_id, conversation_type, group_name
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
