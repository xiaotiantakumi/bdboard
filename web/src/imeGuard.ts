/**
 * IME(かな漢字変換)の変換確定 Enter を、アクション実行の Enter と区別するためのガード。
 *
 * 棚卸し (2026-09-05, bdboard-h4xs.14): web/src のテキスト入力上の Enter keydown ハンドラ
 * 7 箇所 (SearchPalette, TicketDetailPanel×2, BulkActionBar, PresetControl×2, ChatPanel)
 * と ChatPanel の ⌘/Ctrl+Enter 送信に本ガードを適用済み。カード/SVG の role="button" 上の
 * Enter/Space (LaneColumn, DependencyGraphView) は composition が起きないため対象外。
 * グローバル keydown (App.tsx ⌘K/?, PopoverCoordinator Escape, useFocusTrap Tab) は Enter 非対応。
 *
 * 判定は `isComposing` を主とし、`keyCode === 229` を古い環境向けのフォールバックとして
 * 併用する: `isComposing` は KeyboardEvent の標準プロパティだが未実装/未設定の環境が残っており、
 * そこでは IME 変換中のキーが一律 keyCode 229 として届くため。
 *
 * React の合成イベント型 (React.KeyboardEvent) は `isComposing` を持たない (@types/react 19)
 * ため、`nativeEvent.isComposing` も見る。ネイティブの KeyboardEvent もそのまま渡せるよう、
 * 構造的な型で受ける。
 */
export type ImeComposableKeyEvent = {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
};

export function isImeComposingKeyEvent(event: ImeComposableKeyEvent): boolean {
  if (event.isComposing === true || event.nativeEvent?.isComposing === true) {
    return true;
  }
  return event.keyCode === 229;
}
