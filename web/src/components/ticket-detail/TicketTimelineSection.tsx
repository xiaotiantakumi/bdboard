// bdboard-sso1.5 (PR-B): TicketDetailPanel.tsx の「変更履歴」表示ブロックを
// 移動しただけのコンポーネント。state・query は親(TicketDetailPanel)に残し、
// 値とハンドラを props で受け取る表示専用コンポーネント。JSX・className・
// aria属性・文言・DOM構造は移動前から変えていない。
import type { ActivityEventDto } from '../../api';
import {
  ACTIVITY_KIND_LABELS,
  formatActivityTime,
  groupEventsByDate,
} from '../activityFeedFormatting';
import {
  timelineKindBadgeClass,
  formatTimelineChangeDetail,
} from './timelineFormatting';

export interface TicketTimelineSectionProps {
  expanded: boolean;
  onToggleExpanded: () => void;
  loading: boolean;
  error: Error | null;
  events: ActivityEventDto[] | undefined;
}

export function TicketTimelineSection({
  expanded,
  onToggleExpanded,
  loading,
  error,
  events,
}: TicketTimelineSectionProps) {
  return (
    <div className="detail-section">
      <div className="ticket-timeline-header">
        <h3>変更履歴</h3>
        <button
          type="button"
          className="btn ticket-timeline-toggle-btn"
          onClick={onToggleExpanded}
        >
          {expanded ? '閉じる' : '表示'}
        </button>
      </div>
      {expanded && loading && <p className="loading">読み込み中…</p>}
      {expanded && error !== null && (
        <p className="error-message">
          {error instanceof Error
            ? error.message
            : '変更履歴の読み込みに失敗しました'}
        </p>
      )}
      {expanded && events !== undefined && events.length === 0 && (
        <p className="detail-help">変更履歴はありません</p>
      )}
      {expanded && events !== undefined && events.length > 0 && (
        <div className="ticket-timeline-groups">
          {groupEventsByDate(events, new Date()).map((group) => (
            <section
              key={group.heading}
              className="ticket-timeline-date-group"
            >
              <h4 className="ticket-timeline-date-heading">
                {group.heading}
              </h4>
              <ul className="ticket-timeline-list">
                {group.events.map((event) => {
                  const at = new Date(event.at);
                  const changeDetail = formatTimelineChangeDetail(
                    event.kind,
                    event.from,
                    event.to,
                  );
                  const secondaryParts = [
                    event.actor !== undefined ? `@${event.actor}` : undefined,
                    changeDetail,
                    event.reason,
                  ].filter(
                    (part): part is string =>
                      part !== undefined && part.length > 0,
                  );
                  const secondaryText =
                    secondaryParts.length > 0
                      ? secondaryParts.join(' · ')
                      : undefined;

                  return (
                    <li
                      key={`${event.kind}-${event.at}`}
                      className="ticket-timeline-item"
                    >
                      <span className="ticket-timeline-time">
                        {formatActivityTime(at)}
                      </span>
                      <span className={timelineKindBadgeClass(event.kind)}>
                        {ACTIVITY_KIND_LABELS[event.kind]}
                      </span>
                      {secondaryText !== undefined && (
                        <span className="ticket-timeline-detail">
                          {secondaryText}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
