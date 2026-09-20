// bdboard-sso1.5 (PR-G): TicketDetailPanel.tsx の「使用モデル」表示ブロックを
// 移動しただけのコンポーネント。state・mutation は元から無い(純粋な
// プレゼンテーショナルコンポーネント)。JSX・className・文言・DOM構造は
// 移動前から変えていない。
import type { TicketModelDto } from '../../api';

export interface TicketModelsSectionProps {
  models: TicketModelDto[] | undefined;
}

export function TicketModelsSection({ models }: TicketModelsSectionProps) {
  if (models === undefined || models.length === 0) {
    return null;
  }

  return (
    <div className="detail-section">
      <h3>使用モデル</h3>
      <ul className="detail-list">
        {models.map((entry) => (
          <li key={entry.stage}>
            <span className="ticket-model-stage">{entry.stage}</span>
            <span className="ticket-model-name">{entry.model}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
