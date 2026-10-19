import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { reportVisibleProjects } from '../api';

// サーバー側の TTL (5 分) より十分短い間隔で再申告する。
const HEARTBEAT_MS = 2 * 60_000;

// タブごとに固定のクライアント ID (サーバーは ID ごとに最新の申告を持ち、和集合を取る)。
const CLIENT_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}`;

/**
 * bdboard-o1e5: いま画面に出しているプロジェクトをサーバーへ申告する。サーバーはこれを
 * 「停止した Dolt の自動起動」と「ステータスエラーの表示」の対象絞り込みに使う。
 * 選択が空 = 全プロジェクト表示 (ボードの既定) なので、その場合は全プロジェクトの
 * ID を送る。読み込み時・選択変更時・ハートビートで申告し、失敗は無視する
 * (トンネル経由で書き込みが拒否される場合など。申告が無ければサーバーは絞り込まない)。
 */
export function useReportVisibleProjects(
  selectedProjectIds: string[],
  allProjectIds: string[] | undefined,
): void {
  const queryClient = useQueryClient();
  const effective = useMemo(
    () => (selectedProjectIds.length > 0 ? selectedProjectIds : (allProjectIds ?? [])),
    [selectedProjectIds, allProjectIds],
  );
  const key = effective.join('\n');
  const ready = selectedProjectIds.length > 0 || allProjectIds !== undefined;

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    const send = (refetchStatus: boolean): void => {
      reportVisibleProjects(CLIENT_ID, effective).then(
        () => {
          if (refetchStatus && !cancelled) {
            void queryClient.invalidateQueries({ queryKey: ['status'] });
          }
        },
        () => undefined,
      );
    };
    send(true);
    const timer = setInterval(() => send(false), HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // effective は key が同じなら同内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, queryClient]);
}
