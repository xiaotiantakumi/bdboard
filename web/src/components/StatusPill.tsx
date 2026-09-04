import {
  computeStatusLevel,
  formatIsoAge,
  formatRelativeAge,
  STATUS_LABELS,
  type StatusLevel,
} from '../boardFreshness';
import { formatAbsoluteTime } from '../formatAbsoluteTime';
import { useNow } from '../hooks/useNow';
import { usePopoverViewportClamp } from '../hooks/usePopoverViewportClamp';
import type { StreamState } from '../useBoardStream';
import { useExclusivePopover } from './PopoverCoordinator';

export interface StatusPillProps {
  streamState: StreamState;
  connectStalled?: boolean;
  lastContactAtMs: number | null | undefined;
  generatedAt: string | null | undefined;
  lastRefreshAt: string | null | undefined;
  totalSessionCount: number;
  activeSessionCount: number;
  onOpenSessionList: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function statusPillClass(level: StatusLevel): string {
  switch (level) {
    case 'ok':
      return 'status-pill status-pill-ok';
    case 'connecting':
      return 'status-pill status-pill-connecting';
    case 'delayed':
      return 'status-pill status-pill-delayed';
    case 'disconnected':
      return 'status-pill status-pill-disconnected';
    case 'reconnecting':
      return 'status-pill status-pill-reconnecting';
  }
}

export function StatusPill({
  streamState,
  connectStalled = false,
  lastContactAtMs,
  generatedAt,
  lastRefreshAt,
  totalSessionCount,
  activeSessionCount,
  onOpenSessionList,
  open,
  onOpenChange,
}: StatusPillProps) {
  const nowMs = useNow();
  const containerRef = useExclusivePopover('status-pill', open, onOpenChange);
  const popoverRef = usePopoverViewportClamp<HTMLDivElement>(open);
  const level = computeStatusLevel(streamState, lastContactAtMs, nowMs, connectStalled);

  return (
    <div ref={containerRef} className="status-pill-widget header-group">
      <button
        type="button"
        className={statusPillClass(level)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`接続状態: ${STATUS_LABELS[level]}`}
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        {STATUS_LABELS[level]}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="status-pill-popover"
          role="region"
          aria-label="接続状態の詳細"
        >
          {/* ピルの判定は bdboard-9qa 以降 lastContactAtMs 基準なのに、ここだけ
              generatedAt を「盤面取得」と表示していた。静穏時 (ETag 304 が続いて
              generatedAt が凍る) には「正常」ピルの中に「盤面取得: 10分前」が
              同居し、通信が10分止まっているようにも読めてしまう。ラベルを内容の
              鮮度だと分かる語に変え、通信の鮮度を並記して両者を1画面で
              読み分けられるようにする (bdboard-d55)。

              厳密には generatedAt は「今クライアントが持っているペイロードの生成時刻」で、
              サーバーは 200 のたびに now() を入れる。ETag が generatedAt を除外している
              ので 304 が続く間は「内容が変わった時刻」と一致するが、初回ロードや
              ブラウザキャッシュ消失後の 200 では、内容が何時間変わっていなくても
              「たった今」と出る。セッション継続中は正確で、旧「取得」より実態には近い
              ので現状はこの表記で受け入れる (PR#116 fable レビュー minor)。 */}
          {generatedAt !== null && generatedAt !== undefined && (
            <p className="status-pill-detail" title={formatAbsoluteTime(generatedAt)}>
              盤面内容の最終変化: {formatIsoAge(generatedAt, nowMs)}
            </p>
          )}
          {lastContactAtMs !== null && lastContactAtMs !== undefined && (
            <p
              className="status-pill-detail"
              title={formatAbsoluteTime(lastContactAtMs)}
            >
              最終通信: {formatRelativeAge(lastContactAtMs, nowMs)}
            </p>
          )}
          {/* lastRefreshAt はサーバーが bd を読み直して自分のキャッシュへ取り込んだ
              時刻 (main.ts の refreshProjects ループ)。上2行と並ぶと「最終更新」は
              「最終変化」とほぼ同義に読め、主語がサーバーなのかクライアントなのかも
              伝わらなかった。主語が分かる語に改め、表記も上2行と同じ相対時間 +
              絶対値ツールチップに揃えて3行を並べて比較できるようにする
              (bdboard-3dr / bdboard-d55 の積み残し)。 */}
          {lastRefreshAt !== null && lastRefreshAt !== undefined && (
            <p className="status-pill-detail" title={formatAbsoluteTime(lastRefreshAt)}>
              サーバーのbd取込: {formatIsoAge(lastRefreshAt, nowMs)}
            </p>
          )}
          <button
            type="button"
            className="status-pill-session-btn"
            onClick={() => {
              onOpenSessionList();
            }}
          >
            セッション: {totalSessionCount}（稼働中 {activeSessionCount}）
          </button>
        </div>
      )}
    </div>
  );
}
