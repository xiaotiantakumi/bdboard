import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api';
import {
  CHAT_AGENT_AUTH_FAILURE_HELP,
  CHAT_BUSY_HELP,
  RATE_LIMITED_HELP,
} from '../../writeAccessMessage';
import { describeChatSendError } from './chatSendErrors';

// bdboard-sso1.83 第4段: applyChatError の前半(エラー種別 → 文言/clearSession の
// 判定)を describeChatSendError へ抽出した際に足したテーブル駆動テスト。ChatPanel
// 本体(applyChatError)から呼ばれる際の分岐順・文言・clearSession の組み合わせを
// 一箇所で固定する。
describe('describeChatSendError', () => {
  it.each<[string, unknown, { text: string; clearSession: boolean }]>([
    [
      'writeAccessErrorMessage が先に判定する(429 レート制限)',
      new ApiError(429, 'too many requests'),
      { text: RATE_LIMITED_HELP, clearSession: false },
    ],
    [
      '403(writeAccessErrorMessage の既知パターンに一致しない)',
      new ApiError(403, 'forbidden', { errorMessage: 'something else' }),
      { text: 'チャットを利用する権限がありません。', clearSession: false },
    ],
    [
      // bdboard-yzn: writeAccessMessage.ts の CHAT_BUSY_HELP と文言を共有する。
      '409(同一プロジェクトの別メッセージ処理中)',
      new ApiError(409, 'busy'),
      { text: CHAT_BUSY_HELP, clearSession: false },
    ],
    [
      '400 unknown chat session(セッションをクリアして再送を促す)',
      new ApiError(400, 'bad', { errorMessage: 'unknown chat session' }),
      {
        text: '会話の続きが失われました。もう一度送信してください。',
        clearSession: true,
      },
    ],
    [
      '400 chat agent mismatch(セッションをクリアして再送を促す)',
      new ApiError(400, 'bad', { errorMessage: 'chat agent mismatch' }),
      {
        text: 'エージェントが切り替わったため、会話をやり直します。もう一度送信してください。',
        clearSession: true,
      },
    ],
    [
      '400 chat agent does not support image attachments(セッションは維持)',
      new ApiError(400, 'bad', {
        errorMessage: 'chat agent does not support image attachments',
      }),
      {
        text: 'このエージェントは画像入力に対応していません。画像対応エージェントへ切り替えるか、画像を削除してください。',
        clearSession: false,
      },
    ],
    [
      '404(プロジェクトが見つからない)',
      new ApiError(404, 'not found'),
      { text: 'プロジェクトが見つかりません。', clearSession: false },
    ],
    [
      // bdboard-l1t.5
      '502 agent-workspace-untrusted',
      new ApiError(502, 'bad gateway', { code: 'agent-workspace-untrusted' }),
      {
        text: 'このプロジェクト(ワークスペース)を cursor-agent に信頼させる必要があります。bdboard の外で一度 cursor-agent を対話実行し、ワークスペース信頼プロンプトに答えてから、もう一度送信してください。',
        clearSession: false,
      },
    ],
    [
      // bdboard-l1t.6
      '502 agent-headless-denied',
      new ApiError(502, 'bad gateway', { code: 'agent-headless-denied' }),
      {
        text: 'エージェントの headless モードがツール呼び出しを自動拒否したため、応答を得られませんでした。bdboard の外で agy 側の設定 (~/.gemini/antigravity-cli/settings.json) の permissions.allow に bd コマンドの許可ルール(例: "command(bd)")を追加してから、もう一度送信してください。',
        clearSession: false,
      },
    ],
    [
      'chatAgentErrorMessage がマップできるケース(503 chat agent unavailable)',
      new ApiError(503, 'unavailable', { errorMessage: 'chat agent unavailable' }),
      { text: CHAT_AGENT_AUTH_FAILURE_HELP, clearSession: false },
    ],
    [
      'chatAgentErrorMessage がマップできず errorMessage へフォールバック',
      new ApiError(500, 'internal', { errorMessage: 'boom' }),
      { text: 'boom', clearSession: false },
    ],
    [
      'errorMessage も無いときは error.message へフォールバック',
      new ApiError(500, 'raw message'),
      { text: 'raw message', clearSession: false },
    ],
  ])('%s', (_label, error, expected) => {
    expect(describeChatSendError(error)).toEqual(expected);
  });

  it('ApiError 以外の Error は message をそのまま使う', () => {
    expect(describeChatSendError(new Error('network down'))).toEqual({
      text: 'network down',
      clearSession: false,
    });
  });

  it('Error でない値は汎用文言にフォールバックする', () => {
    expect(describeChatSendError('not an error')).toEqual({
      text: '送信に失敗しました',
      clearSession: false,
    });
  });
});
