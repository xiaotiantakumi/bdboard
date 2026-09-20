// bdboard-sso1.2: ChatPanel.tsx から純粋ヘルパーを移動しただけのファイル。
// 挙動は一切変えていない。

// SF3: 会話キーの「新規ドラフト」書式(セッションIDを持たない未送信スレッド)を
// 1箇所に集約する。以前はこの文字列テンプレートが複数箇所(state 初期化・
// startNewDraftThread・draftKey ローカル関数・handleAgentChange)に散在していた。
export function makeDraftKey(projectId: string, nonce: number): string {
  return `new:${projectId}:${nonce}`;
}
