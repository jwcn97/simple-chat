import { useEffect, useRef, useState } from 'react';
import { avatarColorFor } from './avatarColor.js';
import { GroupIcon, SendIcon } from './Icons.jsx';

export function Thread({ username, conversation, messages, onSend }) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);
  const isGroup = conversation.conversationType === 'group';

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function handleSubmit(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  }

  return (
    <div className="thread-panel">
      <div className="thread-header">
        {isGroup ? (
          <div className="avatar group" style={{ width: 38, height: 38 }}>
            <GroupIcon size={17} />
          </div>
        ) : (
          <div className="avatar person" style={{ width: 38, height: 38, fontSize: 14, background: avatarColorFor(conversation.displayName) }}>
            {conversation.displayName[0]?.toUpperCase()}
          </div>
        )}
        <h2 className="serif">{conversation.displayName}</h2>
      </div>

      <div className="thread-messages" ref={scrollRef}>
        {messages.map((m) => {
          const mine = m.from === username;
          return (
            <div key={m.messageId} className={`message-bubble ${mine ? 'mine' : 'theirs'}`}>
              {!mine && isGroup && <div className="message-sender">{m.from}</div>}
              {m.text}
            </div>
          );
        })}
      </div>

      <form className="compose-bar" onSubmit={handleSubmit}>
        <div className="compose-box">
          <input
            placeholder={`Message ${conversation.displayName}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="compose-send" disabled={!draft.trim()}>
            <SendIcon />
          </button>
        </div>
      </form>
    </div>
  );
}
