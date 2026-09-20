import { fetchJson } from './http';

export type QuickActionRequest =
  | { action: 'claim' }
  | { action: 'close'; reason?: string }
  | { action: 'defer'; untilDate: string }
  | { action: 'undefer' }
  | { action: 'priority'; priority: number };

export function postTicketQuickAction(
  id: string,
  body: QuickActionRequest,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/quick-action`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  ).then(() => undefined);
}

// クイックアクションの Undo(逆操作)。claim/close/defer は逆操作の形が一意
// (unclaim/reopen/undefer 相当)なので追加の入力は不要。priority だけは実行前の値を
// 呼び出し元(フロント)が保持して渡す必要がある。expectedCurrentPriority はクイック
// アクション実行直後にセットした値で、サーバー側が Undo 実行時点の実際の優先度と比較する
// CAS チェックに使う(bdboard-3tw.82)。一致しない場合はサーバーが 409 を返し、上書きしない。
export type QuickActionUndoRequest =
  | { action: 'claim' }
  | { action: 'close' }
  | { action: 'defer' }
  | { action: 'undefer'; untilDate: string }
  | {
      action: 'priority';
      previousPriority: number;
      expectedCurrentPriority: number;
    };

export function postTicketQuickActionUndo(
  id: string,
  body: QuickActionUndoRequest,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/quick-action/undo`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  ).then(() => undefined);
}

export function postTicketComment(id: string, text: string): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/comment`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    },
  ).then(() => undefined);
}

export function postTicketDependency(
  id: string,
  dependsOnId: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/dependencies`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dependsOnId }),
    },
  ).then(() => undefined);
}

export function deleteTicketDependency(
  id: string,
  dependsOnId: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/dependencies/${encodeURIComponent(dependsOnId)}`,
    {
      method: 'DELETE',
    },
  ).then(() => undefined);
}

export function postTicketAddLabel(id: string, label: string): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/labels`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    },
  ).then(() => undefined);
}

export function deleteTicketLabel(id: string, label: string): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/labels/${encodeURIComponent(label)}`,
    {
      method: 'DELETE',
    },
  ).then(() => undefined);
}

export function patchTicketTitle(
  id: string,
  title: string,
  expectedCurrentTitle: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/title`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, expectedCurrentTitle }),
    },
  ).then(() => undefined);
}

export function patchTicketDescription(
  id: string,
  description: string,
  expectedCurrentDescription: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/description`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, expectedCurrentDescription }),
    },
  ).then(() => undefined);
}

export function postTicketSessionLink(
  id: string,
  sessionId: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/session-link`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    },
  ).then(() => undefined);
}

export function deleteTicketSessionLink(id: string): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/session-link`,
    {
      method: 'DELETE',
    },
  ).then(() => undefined);
}
