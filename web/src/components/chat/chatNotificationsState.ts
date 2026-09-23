// bdboard-sso1.83 第3段: ChatPanel.tsx の「エラー・通知」表示 state
// (threadError / ticketProjectFallbackNotice) を1つの useReducer に畳んだもの。
// 元は独立した2つの useState<string | null> で、それぞれ:
//   threadError: スレッド一覧取得・削除・リネーム・ピン留め操作の失敗メッセージ
//     (ChatSettingsPanel に表示)
//   ticketProjectFallbackNotice: チケット文脈チャット起動時のプロジェクト解決
//     (未到着/見つからない/フォールバック先で開いた/復帰した)を知らせる通知文言
//     (ChatProjectBar に表示)
// 送受信・添付・スレッドドロワー UI・会話キー再割り当て(bdboard-c1pw の対象)とは
// 独立した「エラーや通知の文言を保持して出し分けるだけ」の表示専用 state で、
// setter は常に直接値(string | null)を渡す形でしか呼ばれていない(関数型更新
// prev => ... は元実装のどの呼び出しサイトにも無い、抽出前に grep で確認済み)。
// そのため reducer 化しても ChatPanel.tsx 側の呼び出し形
// (setThreadError(x) / setTicketProjectFallbackNotice(x)) は変えずに済む。
//
// 同じ値を setXxx(現在値) で呼んだ場合、reducer 化すると dispatch のたびに
// 新しいオブジェクトを spread で作ってしまい、React が新しい state 参照だけを見て
// 子コンポーネントの再描画・effect の再実行まで走らせてしまう。これを防ぐため、
// 各 action は「値が変わらなければ同じ state 参照を返す」ガードを持つ
// (bdboard-sso1.83 第2段のレビュー指摘で chatDraftState.ts に入れたのと同じ
// パターン)。これは React のレンダー結果比較による bail-out(子の再描画・effect
// スキップ)を保つものであり、useState 固有の「同じ値なら ChatPanel 関数本体の
// 再実行自体を省略する」eager bail-out(dispatchSetState の仕組みで、
// useReducer の dispatch には無い)までは再現しない。呼び出しサイトはいずれも
// 同一バッチ内で他の setState を伴うか、無害な ref 再代入しか effect 内で
// 行わないため、ChatPanel 関数本体が1回余分に実行されても実害は無い
// (詳細: bdboard-sso1.83 第3段のレビュー参照)。挙動は変えない。
export interface ChatNotificationsState {
  threadError: string | null;
  ticketProjectFallbackNotice: string | null;
}

export const initialChatNotificationsState: ChatNotificationsState = {
  threadError: null,
  ticketProjectFallbackNotice: null,
};

export type ChatNotificationsAction =
  // 旧: setThreadError(message) / setThreadError(null)
  | { type: 'setThreadError'; message: string | null }
  // 旧: setTicketProjectFallbackNotice(message) / setTicketProjectFallbackNotice(null)
  | { type: 'setTicketProjectFallbackNotice'; message: string | null };

export function chatNotificationsReducer(
  state: ChatNotificationsState,
  action: ChatNotificationsAction,
): ChatNotificationsState {
  switch (action.type) {
    case 'setThreadError':
      if (state.threadError === action.message) {
        return state;
      }
      return { ...state, threadError: action.message };
    case 'setTicketProjectFallbackNotice':
      if (state.ticketProjectFallbackNotice === action.message) {
        return state;
      }
      return { ...state, ticketProjectFallbackNotice: action.message };
    default:
      return state;
  }
}
