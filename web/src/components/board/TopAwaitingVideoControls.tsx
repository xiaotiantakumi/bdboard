import { useEffect, useState, type ReactNode } from 'react';
import { probeOfflineVideoSupport } from '../../lib/offline-video';
import { useTopAwaitingVideoSync } from '../../lib/offline-video/useTopAwaitingVideoSync';

/** ボード読み込み時と表示復帰時に同期し、自動同期は設定が「はい」の場合だけ実行する。 */

export function TopAwaitingVideoControls({ ticketIds, enabled, onEnabledChange }: {
  ticketIds: readonly string[];
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const [supported, setSupported] = useState(false);
  const sync = useTopAwaitingVideoSync(ticketIds, enabled, supported);
  useEffect(() => { void probeOfflineVideoSupport().then(setSupported); }, []);
  if (!supported || !sync.authenticated) return null;
  const status = sync.progress?.phase === 'saving'
    ? `保存中 ${sync.progress.done}/${sync.progress.total}`
    : sync.progress?.phase === 'done' ? '上位3件を保存済み'
      : sync.progress?.phase === 'stopped' ? '容量上限のため一部のみ保存' : '';
  return <div className="top-awaiting-video-controls" onClick={(event) => event.stopPropagation()}>
    <label><input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
      自動ダウンロード（上位3件）</label>
    <button type="button" className="btn btn-small" disabled={!ticketIds.length || sync.progress?.phase === 'saving'}
      onClick={() => { void sync.save().catch(() => undefined); }}>上位3件を保存</button>
    {status && <span role="status">{status}</span>}
    {sync.failed && <span role="status">保存に失敗しました</span>}
    {enabled && sync.home === 'unknown' && <small>自宅と判定できないため自動では保存しません。ボタンで保存できます</small>}
  </div>;
}

/** 確認待ちレーンの見出しに置く操作。上位3件は描画中のカード順 (並べ替えない) から取る。 */
export function topAwaitingAddon(
  lane: string,
  cards: readonly { ticket: { id: string } }[],
  enabled: boolean | null,
  onEnabledChange: (enabled: boolean) => void,
): ReactNode {
  if (lane !== 'awaiting_human' || enabled === null) return undefined;
  const ticketIds = cards.slice(0, 3).map((card) => card.ticket.id);
  return <TopAwaitingVideoControls ticketIds={ticketIds} enabled={enabled} onEnabledChange={onEnabledChange} />;
}
