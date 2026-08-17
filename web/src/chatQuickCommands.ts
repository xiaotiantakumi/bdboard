export type ChatQuickCommand = {
  id: string;
  label: string;
  prompt: string;
};

/**
 * チャット入力欄上に並べる定型プロンプト。スマホ(トンネル)での手入力を減らす。
 * bdboard-3tw.133: 誤タップでの誤送信を避けるため、どのチップも常に入力欄への
 * プリフィルのみを行い、即時送信はしない(送信するかどうかは必ずユーザーが
 * 送信ボタン/⌘+Enterで判断する)。
 */
export const CHAT_QUICK_COMMANDS: readonly ChatQuickCommand[] = [
  {
    id: 'ready-list',
    label: 'ready一覧',
    prompt:
      '着手可能(ready)なチケットを一覧し、優先度が高い順に要約してください。',
  },
  {
    id: 'stalled-check',
    label: '滞留確認',
    prompt:
      'このプロジェクトで滞留しているチケットを確認し、対応の優先順位を提案してください。',
  },
  {
    id: 'in-progress-list',
    label: '作業中',
    prompt: '作業中(in_progress)のチケットを一覧し、各チケットの状況を短くまとめてください。',
  },
  {
    id: 'blocked-list',
    label: 'blocked',
    prompt: 'ブロック中のチケットと、その理由を教えてください。',
  },
  {
    id: 'awaiting-human',
    label: '人の判断待ち',
    prompt:
      '人の判断待ち(awaiting_human)のチケットを一覧し、何を決める必要があるか教えてください。',
  },
  {
    id: 'custom-prefill',
    label: 'チケット相談',
    prompt: '次のチケットについて: ',
  },
];
