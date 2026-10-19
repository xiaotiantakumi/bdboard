import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { fetchJson } from '../api/http';
import { acquireSharedEventSource } from '../lib/sseConnection';

// サーバー側の TTL (5 分) より十分短い間隔で再申告する。
export const VISIBLE_PROJECTS_HEARTBEAT_MS = 2 * 60_000;
// 申告に失敗したときの再送間隔。
export const VISIBLE_PROJECTS_RETRY_MS = 7_000;

// タブごとに固定のクライアント ID (サーバーは ID ごとに最新の申告を持ち、和集合を取る)。
const CLIENT_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}`;

/** projectIds が null = 選択が空 (全プロジェクト表示) のワイルドカード。 */
export function buildVisibleProjectsPayload(
  clientId: string,
  projectIds: readonly string[],
): { clientId: string; all: true } | { clientId: string; projectIds: string[] } {
  return projectIds.length === 0
    ? { clientId, all: true }
    : { clientId, projectIds: [...projectIds] };
}

export function reportVisibleProjects(
  clientId: string,
  projectIds: readonly string[],
): Promise<void> {
  return fetchJson<{ ok: boolean }>('/api/ui/visible-projects', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildVisibleProjectsPayload(clientId, projectIds)),
  }).then(() => undefined);
}

/**
 * bdboard-o1e5: いま画面に出しているプロジェクトをサーバーへ申告する。サーバーはこれを
 * 「停止した Dolt の自動起動」と「ステータスエラーの表示」の対象絞り込みに使う。
 * 選択が空 = 全プロジェクト表示 (ボードの既定) なので、その場合はワイルドカード
 * (`all: true`) を送る。読み込み時・選択変更時・SSE の接続/再接続時・ハートビートで
 * 申告し、成功するたびにステータスを取り直す。失敗 (サーバー停止・トンネル経由で書き込み
 * 拒否など) は数秒後に再送する。申告が無ければサーバーは絞り込まない。
 */
export function useReportVisibleProjects(selectedProjectIds: string[]): void {
  const queryClient = useQueryClient();
  const key = useMemo(() => selectedProjectIds.join('\n'), [selectedProjectIds]);

  useEffect(() => {
    const ids = key === '' ? [] : key.split('\n');
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (): void => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      reportVisibleProjects(CLIENT_ID, ids).then(
        () => {
          if (!cancelled) {
            void queryClient.invalidateQueries({ queryKey: ['status'] });
          }
        },
        () => {
          if (!cancelled && retryTimer === null) {
            retryTimer = setTimeout(send, VISIBLE_PROJECTS_RETRY_MS);
          }
        },
      );
    };

    send();
    const heartbeat = setInterval(send, VISIBLE_PROJECTS_HEARTBEAT_MS);
    // SSE の接続・再接続のたびに再申告する (サーバー再起動で申告が消えた場合の回復)。
    const conn = acquireSharedEventSource();
    conn.addOpenListener(send);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
      conn.removeOpenListener(send);
      conn.release();
    };
  }, [key, queryClient]);
}
