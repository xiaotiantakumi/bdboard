/**
 * キーボードショートカット一覧の単一ソース。
 * ヘルプオーバーレイはこの配列を描画する。実際の keydown 判定は各コンポーネントに分散している。
 */

export interface KeyboardShortcutDefinition {
  id: string;
  category: string;
  keys: string;
  description: string;
}

/** 修飾キー + K の表示用ラベル（ChatPanel の ⌘/Ctrl 表記に合わせる） */
export const MODIFIER_ENTER_LABEL = '⌘/Ctrl + Enter';

/** コマンドパレットの表示用ラベル */
export const COMMAND_PALETTE_KEYS_LABEL = '⌘/Ctrl + K';

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutDefinition[] = [
  {
    id: 'board-next-card',
    category: 'ボード',
    keys: 'j / ↓',
    description: '次のカードへ移動',
  },
  {
    id: 'board-prev-card',
    category: 'ボード',
    keys: 'k / ↑',
    description: '前のカードへ移動',
  },
  {
    id: 'board-next-lane',
    category: 'ボード',
    keys: 'l / →',
    description: '次のレーンへ移動',
  },
  {
    id: 'board-prev-lane',
    category: 'ボード',
    keys: 'h / ←',
    description: '前のレーンへ移動',
  },
  {
    id: 'board-first-card',
    category: 'ボード',
    keys: 'Home',
    description: 'レーン内の先頭カードへ移動',
  },
  {
    id: 'board-last-card',
    category: 'ボード',
    keys: 'End',
    description: 'レーン内の末尾カードへ移動',
  },
  {
    id: 'board-open-card',
    category: 'ボード',
    keys: 'Enter / Space',
    description: 'フォーカス中のカードの詳細を開く',
  },
  {
    id: 'global-command-palette',
    category: '全体',
    keys: COMMAND_PALETTE_KEYS_LABEL,
    description: 'コマンドパレットを開く',
  },
  {
    id: 'global-shortcuts-help',
    category: '全体',
    keys: '?',
    description: 'キーボードショートカット一覧を開く',
  },
  {
    id: 'global-close',
    category: '全体',
    keys: 'Escape',
    description: '開いているパネル・モーダルを閉じる',
  },
  {
    id: 'palette-nav',
    category: 'コマンドパレット',
    keys: '↑ / ↓',
    description: '候補を移動（パレット表示中）',
  },
  {
    id: 'palette-select',
    category: 'コマンドパレット',
    keys: 'Enter',
    description: '候補を実行（パレット表示中）',
  },
  {
    id: 'detail-focus-comment',
    category: 'チケット詳細',
    keys: 'c',
    description: 'コメント入力欄にフォーカス（詳細パネル表示中）',
  },
  {
    id: 'chat-send',
    category: 'チャット',
    keys: MODIFIER_ENTER_LABEL,
    description: 'メッセージを送信（チャット表示中）',
  },
];

/** Cmd+K と ? の入力欄フォーカスガード（App.tsx 等で共用） */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  // jsdom does not implement isContentEditable; contentEditable string works in both.
  return target.isContentEditable === true || target.contentEditable === 'true';
}

export function groupKeyboardShortcuts(
  shortcuts: readonly KeyboardShortcutDefinition[],
): Map<string, KeyboardShortcutDefinition[]> {
  const groups = new Map<string, KeyboardShortcutDefinition[]>();
  for (const entry of shortcuts) {
    const list = groups.get(entry.category);
    if (list === undefined) {
      groups.set(entry.category, [entry]);
    } else {
      list.push(entry);
    }
  }
  return groups;
}
