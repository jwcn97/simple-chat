import { avatarColorFor } from './avatarColor.js';
import { GroupIcon, PlusIcon, SearchIcon } from './Icons.jsx';

function timeAgo(ts) {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function ConversationRow({ conversation, active, onSelect }) {
  const isGroup = conversation.conversationType === 'group';
  return (
    <button
      className={`conversation-row${active ? ' active' : ''}`}
      onClick={onSelect}
    >
      {isGroup ? (
        <div className="avatar group">
          <GroupIcon />
        </div>
      ) : (
        <div className="avatar person" style={{ background: avatarColorFor(conversation.displayName) }}>
          {conversation.displayName[0]?.toUpperCase()}
        </div>
      )}
      <div className="conversation-meta">
        <div className="conversation-meta-top">
          <span className="conversation-name">{conversation.displayName}</span>
          <span className="conversation-time">{timeAgo(conversation.lastMessageAt)}</span>
        </div>
        <div className="conversation-preview">{conversation.lastMessagePreview}</div>
      </div>
    </button>
  );
}

export function Sidebar({ username, conversations, activeId, onSelect, onNewConversation }) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1 className="serif">Keeper</h1>
        <div className="sidebar-username">{username}</div>
      </div>

      <div className="sidebar-search">
        <div className="sidebar-search-box">
          <SearchIcon /> &nbsp;Search or start new…
        </div>
      </div>

      <div className="conversation-list">
        {conversations.map((c) => (
          <ConversationRow
            key={c.conversationId}
            conversation={c}
            active={c.conversationId === activeId}
            onSelect={() => onSelect(c)}
          />
        ))}
      </div>

      <div className="new-conversation-bar">
        <button onClick={onNewConversation}>
          <PlusIcon />
          New conversation
        </button>
      </div>
    </div>
  );
}
