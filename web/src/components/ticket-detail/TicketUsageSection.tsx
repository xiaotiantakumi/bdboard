// bdboard-sso1.5 (PR-G): TicketDetailPanel.tsx の「AI使用量」表示ブロックを
// 移動しただけのコンポーネント。state・mutation は元から無い(純粋な
// プレゼンテーショナルコンポーネント)。JSX・className・文言・DOM構造は
// 移動前から変えていない。
import type { TicketTokenUsageDto } from '../../api';
import { formatTokenCount } from './formatters';

export interface TicketUsageSectionProps {
  usage: TicketTokenUsageDto | undefined;
}

export function TicketUsageSection({ usage }: TicketUsageSectionProps) {
  if (usage === undefined) {
    return null;
  }

  return (
    <div className="detail-section">
      <h3>AI使用量</h3>
      <div className="detail-field">
        <div className="detail-field-label">入力トークン</div>
        <div>{formatTokenCount(usage.totalInputTokens)}</div>
      </div>
      <div className="detail-field">
        <div className="detail-field-label">出力トークン</div>
        <div>{formatTokenCount(usage.totalOutputTokens)}</div>
      </div>
      {(usage.totalCacheCreationInputTokens > 0 ||
        usage.totalCacheReadInputTokens > 0) && (
        <>
          <div className="detail-field">
            <div className="detail-field-label">キャッシュ作成入力</div>
            <div>{formatTokenCount(usage.totalCacheCreationInputTokens)}</div>
          </div>
          <div className="detail-field">
            <div className="detail-field-label">キャッシュ読み取り入力</div>
            <div>{formatTokenCount(usage.totalCacheReadInputTokens)}</div>
          </div>
        </>
      )}
      {usage.byModel.length > 0 && (
        <ul className="detail-list">
          {usage.byModel.map((entry) => (
            <li key={entry.model}>
              {entry.model}: 入力 {formatTokenCount(entry.inputTokens)} / 出力{' '}
              {formatTokenCount(entry.outputTokens)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
