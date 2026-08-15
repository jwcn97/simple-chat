import pg from 'pg';

const connectionString =
  process.env.DATABASE_URL || 'postgres://chat:chat@localhost:5432/chat';

export const pool = new pg.Pool({ connectionString });

// Deterministic so either participant computes the same conversation id
// independently, with no lookup required to find "the" conversation
// between two given users.
export function conversationIdFor(userA, userB) {
  return [userA, userB].sort().join('|');
}
