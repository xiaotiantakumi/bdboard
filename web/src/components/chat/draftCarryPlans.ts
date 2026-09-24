// bdboard-sso1.83 第4段: ChatPanel.tsx から定数を移動しただけのファイル。
// 挙動は一切変えていない。
import { defineDraftPayloadStoreCarryPlan } from '../conversationKeyspace';

// bdboard-ru4d: 会話キー再割り当てサイトごとのドラフト積載物引き継ぎ選択。
// ストアを1つ増やすと、ここと3サイト(chat/useDraftThreadLauncher.ts の handleAgentChange /
// startNewDraftThread、chat/useChatSendCommits.ts の commitSuccess)すべてで選択を書かない限り tsc が落ちる。

/** handleAgentChange: 本文・添付・シード記録のみ引き継ぐ。 */
export const HANDLE_AGENT_CHANGE_DRAFT_PAYLOAD_CARRY = defineDraftPayloadStoreCarryPlan({
  conversationInputs: { carry: true },
  conversationAttachments: { carry: true },
  draftSeedText: { carry: true },
  attachmentErrors: {
    carry: false,
    reason: 'エージェント切替では添付エラー状態を引き継がない',
  },
  threadModelIds: {
    carry: false,
    reason: '旧エージェント向けモデル選択を新キーへ持ち込むとモデル漏れになる',
  },
});

/** startNewDraftThread: 通常の「新規スレッド」は何も引き継がない。 */
export const START_NEW_DRAFT_THREAD_CARRY = defineDraftPayloadStoreCarryPlan({
  conversationInputs: {
    carry: false,
    reason: '明示的な新規スレッドは空のドラフトで始まる',
  },
  conversationAttachments: {
    carry: false,
    reason: '明示的な新規スレッドは空のドラフトで始まる',
  },
  attachmentErrors: {
    carry: false,
    reason: '明示的な新規スレッドは空のドラフトで始まる',
  },
  threadModelIds: {
    carry: false,
    reason: '明示的な新規スレッドは空のドラフトで始まる',
  },
  draftSeedText: {
    carry: false,
    reason: '明示的な新規スレッドは空のドラフトで始まる',
  },
});

/** startNewDraftThread: pendingPrefill 消化時は計算値を引き継ぐ。 */
export const START_NEW_DRAFT_THREAD_PREFILL_CARRY = defineDraftPayloadStoreCarryPlan({
  conversationInputs: { carry: true },
  conversationAttachments: { carry: true },
  draftSeedText: { carry: true },
  threadModelIds: { carry: true },
  attachmentErrors: {
    carry: false,
    reason: 'pendingPrefill 消化では添付エラー状態を引き継がない',
  },
});

/** commitSuccess(旧 applyChatSuccess): ドラフト積載物は送信時点でクリア済み。conversations のみ移送。 */
export const APPLY_CHAT_SUCCESS_DRAFT_PAYLOAD_CARRY = defineDraftPayloadStoreCarryPlan({
  conversationInputs: {
    carry: false,
    reason: '送信時点でドラフト積載物はクリア済み',
  },
  conversationAttachments: {
    carry: false,
    reason: '送信時点でドラフト積載物はクリア済み',
  },
  attachmentErrors: {
    carry: false,
    reason: '送信時点でドラフト積載物はクリア済み',
  },
  threadModelIds: {
    carry: false,
    reason: '送信時点でドラフト積載物はクリア済み(sessionId 確定後は別経路でモデルを設定)',
  },
  draftSeedText: {
    carry: false,
    reason: '送信時点でドラフト積載物はクリア済み',
  },
});
