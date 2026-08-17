import { useWatchedTickets } from './WatchedTicketsProvider';

interface WatchToggleProps {
  ticketId: string;
  className?: string;
}

export function WatchToggle({ ticketId, className }: WatchToggleProps) {
  const { isWatched, toggleWatch } = useWatchedTickets();
  const watched = isWatched(ticketId);

  return (
    <button
      type="button"
      className={`watch-toggle${watched ? ' watch-toggle-active' : ''}${className !== undefined ? ` ${className}` : ''}`}
      aria-pressed={watched}
      aria-label={watched ? 'ウォッチ解除' : 'ウォッチ'}
      title={watched ? 'ウォッチ解除' : 'ウォッチ'}
      onClick={(event) => {
        event.stopPropagation();
        toggleWatch(ticketId);
      }}
    >
      <span className="watch-toggle-icon" aria-hidden="true">
        {watched ? '★' : '☆'}
      </span>
    </button>
  );
}
