import { useState } from 'react';
import { avatarColorFor } from './avatarColor.js';

export function NewConversationModal({ onClose, onStartChat, onCreateGroup }) {
  const [mode, setMode] = useState('chat');
  const [chatUsername, setChatUsername] = useState('');

  const [groupName, setGroupName] = useState('');
  const [members, setMembers] = useState([]);
  const [memberDraft, setMemberDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function addMember() {
    const name = memberDraft.trim();
    if (name && !members.includes(name)) {
      setMembers([...members, name]);
    }
    setMemberDraft('');
  }

  function handleMemberKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addMember();
    } else if (e.key === 'Backspace' && !memberDraft && members.length > 0) {
      setMembers(members.slice(0, -1));
    }
  }

  function handleChatSubmit(e) {
    e.preventDefault();
    const name = chatUsername.trim();
    if (!name) return;
    onStartChat(name);
  }

  async function handleGroupSubmit(e) {
    e.preventDefault();
    if (!groupName.trim() || members.length + 1 < 3) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreateGroup({ name: groupName.trim(), members });
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="serif">Start something new</h2>

        <div className="tab-toggle">
          <button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>
            New chat
          </button>
          <button type="button" className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>
            New group
          </button>
        </div>

        {mode === 'chat' ? (
          <form onSubmit={handleChatSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div className="field">
              <label htmlFor="chat-username">Username</label>
              <input id="chat-username" value={chatUsername} onChange={(e) => setChatUsername(e.target.value)} autoFocus />
            </div>
            <div className="modal-actions">
              <button type="button" className="button-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="button-primary serif" disabled={!chatUsername.trim()}>Start chatting</button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleGroupSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div className="field">
              <label htmlFor="group-name">Group name</label>
              <input id="group-name" value={groupName} onChange={(e) => setGroupName(e.target.value)} autoFocus />
            </div>

            <div className="field">
              <label>Members</label>
              <div className="member-chips">
                {members.map((m) => (
                  <button
                    type="button"
                    key={m}
                    className="member-chip"
                    onClick={() => setMembers(members.filter((x) => x !== m))}
                    title="Remove"
                  >
                    <div className="avatar person" style={{ background: avatarColorFor(m) }}>{m[0]?.toUpperCase()}</div>
                    {m}
                  </button>
                ))}
                <input
                  className="chip-input"
                  placeholder={members.length === 0 ? 'type a username…' : ''}
                  value={memberDraft}
                  onChange={(e) => setMemberDraft(e.target.value)}
                  onKeyDown={handleMemberKeyDown}
                  onBlur={addMember}
                />
              </div>
              <div className="field-hint">You're included automatically — 3 members minimum.</div>
            </div>

            {error && <div className="error-message">{error}</div>}

            <div className="modal-actions">
              <button type="button" className="button-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="button-primary serif" disabled={submitting || !groupName.trim() || members.length + 1 < 3}>
                {submitting ? 'Creating…' : 'Create group'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
