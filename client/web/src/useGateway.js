import { useCallback, useEffect, useRef, useState } from 'react';
import { login as apiLogin } from './api.js';

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || 'ws://localhost:3001';

// Same deterministic pairing as db.js's conversationIdFor — a 1:1
// conversation has no id of its own on the wire, so the client derives
// the same key the server would for the same two people.
export function directKeyFor(a, b) {
  return [a, b].sort().join('|');
}

function keyForMessage(msg, myUsername) {
  if (msg.toGroup) return msg.toGroup;
  const other = msg.from === myUsername ? msg.to : msg.from;
  return directKeyFor(myUsername, other);
}

// A chat app's own hook for talking to one gateway: owns the connection
// lifecycle (including re-logging in on every reconnect, since tokens
// expire and a stale one would otherwise just retry forever against a
// gateway that keeps rejecting it), the catch-up cursor, the running
// conversation list, and per-conversation message threads.
export function useGateway(username, password) {
  const [connected, setConnected] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [messagesByConversation, setMessagesByConversation] = useState({});
  const [error, setError] = useState(null);

  const wsRef = useRef(null);
  const cursorRef = useRef({ ts: 0, messageId: null });
  const seenIdsRef = useRef(new Set());
  const pendingGroupRef = useRef(null);

  const upsertConversation = useCallback((entry) => {
    setConversations((prev) => {
      const rest = prev.filter((c) => c.conversationId !== entry.conversationId);
      return [entry, ...rest];
    });
  }, []);

  const applyMessage = useCallback((msg) => {
    const key = keyForMessage(msg, username);

    if (msg.messageId) {
      if (seenIdsRef.current.has(msg.messageId)) return;
      seenIdsRef.current.add(msg.messageId);
    }
    if (!msg.messageId?.startsWith('local-')) {
      cursorRef.current = { ts: msg.ts, messageId: msg.messageId };
    }

    setMessagesByConversation((prev) => ({
      ...prev,
      [key]: [...(prev[key] || []), msg],
    }));

    const displayName = msg.toGroup ? msg.groupName : (msg.from === username ? msg.to : msg.from);
    upsertConversation({
      conversationId: key,
      conversationType: msg.toGroup ? 'group' : 'direct',
      displayName,
      lastMessagePreview: msg.text,
      lastMessageAt: msg.ts,
    });
  }, [username, upsertConversation]);

  const connect = useCallback(async () => {
    let token;
    try {
      ({ token } = await apiLogin(username, password));
    } catch (err) {
      setError(`Login failed: ${err.message}`);
      setTimeout(connect, 1500);
      return;
    }

    const params = new URLSearchParams({ token });
    if (cursorRef.current.messageId) {
      params.set('afterTs', String(cursorRef.current.ts));
      params.set('afterMessageId', cursorRef.current.messageId);
    }
    const ws = new WebSocket(`${GATEWAY_URL}?${params}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);

      if (payload.conversations) {
        // Only meaningful on a fresh connect (an empty local cursor) —
        // on a reconnect the client already has a running list and this
        // would just be a duplicate, slightly stale snapshot.
        if (!cursorRef.current.messageId) {
          setConversations(
            payload.conversations
              .slice()
              .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
          );
        }
        return;
      }

      if (payload.groupCreated) {
        pendingGroupRef.current?.resolve(payload.groupCreated);
        pendingGroupRef.current = null;
        upsertConversation({
          conversationId: payload.groupCreated.groupId,
          conversationType: 'group',
          displayName: payload.groupCreated.name,
          lastMessagePreview: 'You created this group',
          lastMessageAt: Date.now(),
        });
        return;
      }

      if (payload.error) {
        pendingGroupRef.current?.reject(new Error(payload.error));
        pendingGroupRef.current = null;
        setError(payload.error);
        return;
      }

      applyMessage(payload);
    };

    ws.onclose = () => {
      setConnected(false);
      setTimeout(connect, 1500);
    };

    ws.onerror = () => {
      // 'close' follows right after — the retry there covers it.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, password, applyMessage, upsertConversation]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendMessage = useCallback(({ to, toGroup, groupName, text }) => {
    const localMessage = {
      messageId: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      from: username,
      to,
      toGroup,
      groupName,
      text,
      ts: Date.now(),
    };
    applyMessage(localMessage);
    wsRef.current?.send(JSON.stringify({ to, toGroup, text }));
  }, [username, applyMessage]);

  const createGroup = useCallback(({ name, members }) => {
    return new Promise((resolve, reject) => {
      pendingGroupRef.current = { resolve, reject };
      wsRef.current?.send(JSON.stringify({ createGroup: { name, members } }));
    });
  }, []);

  return { connected, conversations, messagesByConversation, error, sendMessage, createGroup };
}
