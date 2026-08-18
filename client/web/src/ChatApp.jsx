import { useEffect, useState } from 'react';
import { useGateway, directKeyFor } from './useGateway.js';
import { Sidebar } from './Sidebar.jsx';
import { Thread } from './Thread.jsx';
import { EmptyState } from './EmptyState.jsx';
import { NewConversationModal } from './NewConversationModal.jsx';

export function ChatApp({ username, password }) {
  const { conversations, messagesByConversation, sendMessage, createGroup, error } = useGateway(username, password);
  const [activeConversation, setActiveConversation] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [toast, setToast] = useState(null);

  // The hook's `error` covers server-side failures that aren't part of a
  // pending group-creation call (that one's already shown inline in the
  // modal) — e.g. a send that the server rejected. Surface it briefly
  // rather than let it vanish silently.
  useEffect(() => {
    if (!error) return;
    setToast(error);
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const activeId = activeConversation?.conversationId ?? null;
  // The list is the source of truth once a conversation has a real
  // entry (e.g. after the first message) — fall back to the locally
  // held object for a brand-new chat that hasn't sent anything yet.
  const activeFromList = conversations.find((c) => c.conversationId === activeId);
  const active = activeFromList || activeConversation;

  function handleSend(text) {
    if (!active) return;
    if (active.conversationType === 'group') {
      sendMessage({ toGroup: active.conversationId, groupName: active.displayName, text });
    } else {
      sendMessage({ to: active.displayName, text });
    }
  }

  function handleStartChat(otherUsername) {
    setActiveConversation({
      conversationId: directKeyFor(username, otherUsername),
      conversationType: 'direct',
      displayName: otherUsername,
      lastMessagePreview: '',
      lastMessageAt: Date.now(),
    });
    setShowModal(false);
  }

  async function handleCreateGroup({ name, members }) {
    const { groupId } = await createGroup({ name, members });
    setActiveConversation({
      conversationId: groupId,
      conversationType: 'group',
      displayName: name,
      lastMessagePreview: '',
      lastMessageAt: Date.now(),
    });
    setShowModal(false);
  }

  return (
    <div className="chat-shell">
      {toast && (
        <div className="error-toast">
          {toast}
        </div>
      )}

      <Sidebar
        username={username}
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveConversation}
        onNewConversation={() => setShowModal(true)}
      />

      {active ? (
        <Thread
          username={username}
          conversation={active}
          messages={messagesByConversation[active.conversationId] || []}
          onSend={handleSend}
        />
      ) : (
        <EmptyState />
      )}

      {showModal && (
        <NewConversationModal
          onClose={() => setShowModal(false)}
          onStartChat={handleStartChat}
          onCreateGroup={handleCreateGroup}
        />
      )}
    </div>
  );
}
