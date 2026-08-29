import { useQuery } from '@tanstack/react-query';
import { fetchActivity, type ActivityEventDto } from '../api';
import {
  ACTIVITY_WINDOW_DAYS,
  activityWindowLabel,
  type ActivityWindowDays,
} from '../uiPersistedState';
import {
  ACTIVITY_KIND_LABELS,
  formatActivityTime,
  groupEventsByDate,
} from './activityFeedFormatting';
import { togglePressedProps } from './toggleGroupA11y';

export interface ActivityFeedProps {
  readonly projectIds: readonly string[];
  windowDays: ActivityWindowDays;
  onWindowDaysChange: (days: ActivityWindowDays) => void;
  onSelectTicket: (ticketId: string) => void;
  now?: Date;
}

function priorityBadgeClass(priority: number): string {
  if (priority === 0) return 'badge-p0';
  if (priority === 1) return 'badge-p1';
  if (priority === 2) return 'badge-p2';
  if (priority === 3) return 'badge-p3';
  return 'badge-p4';
}

function kindBadgeClass(kind: keyof typeof ACTIVITY_KIND_LABELS): string {
  return `activity-kind-badge activity-kind-${kind}`;
}

function formatChangeDetail(
  kind: ActivityEventDto['kind'],
  from: string | undefined,
  to: string | undefined,
): string | undefined {
  if (
    (kind === 'status_changed' || kind === 'priority_changed') &&
    from !== undefined &&
    to !== undefined
  ) {
    return `${from} → ${to}`;
  }
  return undefined;
}

export function ActivityFeed({
  projectIds,
  windowDays,
  onWindowDaysChange,
  onSelectTicket,
  now: nowOverride,
}: ActivityFeedProps) {
  const projectIdsKey = projectIds.join(',');
  const query = useQuery({
    queryKey: ['activity', windowDays, projectIdsKey],
    queryFn: () => fetchActivity(windowDays, 100, projectIds),
  });

  const now = nowOverride ?? new Date();
  const groups =
    query.data !== undefined ? groupEventsByDate(query.data, now) : [];

  return (
    <section className="activity-feed" aria-label="アクティビティ">
      <div className="activity-feed-header">
        <h2 className="activity-feed-title">アクティビティ</h2>
        <div className="activity-window-group">
          <span className="header-label">期間</span>
          <div className="toggle-group">
            {ACTIVITY_WINDOW_DAYS.map((option) => (
              <button
                key={option}
                type="button"
                className={`toggle-btn${windowDays === option ? ' active' : ''}`}
                {...togglePressedProps(windowDays === option)}
                onClick={() => onWindowDaysChange(option)}
              >
                {activityWindowLabel(option)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {query.isLoading && <p className="loading">読み込み中…</p>}
      {query.isError && (
        <p className="error-message">
          {query.error instanceof Error
            ? query.error.message
            : 'アクティビティの読み込みに失敗しました'}
        </p>
      )}
      {query.data !== undefined && query.data.length === 0 && (
        <p className="empty-message">この期間の動きはありません</p>
      )}
      {query.data !== undefined && query.data.length > 0 && (
        <div className="activity-feed-timeline">
          {groups.map((group) => (
            <section key={group.heading} className="activity-date-group">
              <h3 className="activity-date-heading">{group.heading}</h3>
              <ul className="activity-event-list">
                {group.events.map((event) => {
                  const at = new Date(event.at);
                  const changeDetail = formatChangeDetail(event.kind, event.from, event.to);
                  const secondaryParts = [
                    event.actor !== undefined ? `@${event.actor}` : undefined,
                    changeDetail,
                    event.reason,
                  ].filter((part): part is string => part !== undefined && part.length > 0);
                  const secondaryText =
                    secondaryParts.length > 0 ? secondaryParts.join(' · ') : undefined;

                  return (
                    <li key={`${event.kind}-${event.id}-${event.at}`}>
                      <button
                        type="button"
                        className="activity-event-row"
                        onClick={() => onSelectTicket(event.id)}
                      >
                        <div className="activity-event-main">
                          <span className="activity-event-time">
                            {formatActivityTime(at)}
                          </span>
                          <span className={kindBadgeClass(event.kind)}>
                            {ACTIVITY_KIND_LABELS[event.kind]}
                          </span>
                          <span className="activity-event-project">
                            {event.projectName}
                          </span>
                          <span className="activity-event-id">{event.id}</span>
                          <span className="activity-event-title">{event.title}</span>
                          <span
                            className={`badge ${priorityBadgeClass(event.priority)}`}
                          >
                            P{event.priority}
                          </span>
                        </div>
                        {secondaryText !== undefined && (
                          <span className="activity-event-secondary">{secondaryText}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
