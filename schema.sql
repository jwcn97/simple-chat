-- conversations: one row per 1:1 pair, id is deterministic (see conversationIdFor
-- in db.js) so both participants always compute the same id independently.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_a_id TEXT NOT NULL,
  user_b_id TEXT NOT NULL,
  last_message_at TIMESTAMPTZ
);

-- messages: the durable source of truth. Pub/sub (in gateway.js) is only
-- ever a live nudge on top of what's already safely written here.
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the one index that matters: turns "last N messages in this conversation"
-- from a full table scan into a direct range lookup.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);
