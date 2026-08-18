import { LogoIcon } from './Icons.jsx';

export function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-state-inner">
        <LogoIcon size={52} />
        <h2 className="serif">Nothing selected yet</h2>
        <p>Pick a conversation on the left, or start something new.</p>
      </div>
    </div>
  );
}
