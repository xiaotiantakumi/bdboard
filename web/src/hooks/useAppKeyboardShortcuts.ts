import { useEffect } from 'react';
import { isTypingTarget } from '../keyboardShortcuts';

export interface AppKeyboardShortcutsParams {
  helpOpen: boolean;
  tunnelModalOpen: boolean;
  chatOpen: boolean;
  searchOpen: boolean;
  sessionListOpen: boolean;
  shortcutsOpen: boolean;
  selectedTicketId: string | null;
  onOpenSearch: () => void;
  onOpenShortcuts: () => void;
  onCloseShortcuts: () => void;
}

/**
 * App.tsx のグローバルキーボードショートカット2本
 * (Cmd/Ctrl+K でコマンドパレットを開く、`?` でショートカット一覧の開閉)を
 * まとめるフック(bdboard-62p4 第4段)。元の App.tsx (旧 L500-572) から
 * document.addEventListener の登録内容・イベント判定条件・early return の
 * 並びを一切変えていない。
 *
 * 呼び出し位置について: App.tsx では useAppOverlays() の直後、元の2つの
 * effect があった位置 (epicFilterId 切り替え effect の直後) でこのフックを
 * 1回だけ呼ぶ。これにより2つの useEffect は元と同じ相対順序 (Cmd/Ctrl+K →
 * `?`) で登録される。
 *
 * 依存配列について: 元のコードは onOpenSearch/onOpenShortcuts/
 * onCloseShortcuts に相当する処理を setSearchOpen(true) 等の setState
 * 呼び出しとして直接インライン化しており、setState セッター自体は
 * react-hooks/exhaustive-deps が安定参照とみなすため依存配列に含まれて
 * いなかった。ここでは useAppOverlays 側の useCallback (深さ0の安定した
 * 参照) を挟んで渡しているため、lint 上は依存配列に加える必要があるが、
 * これらの参照は再レンダーをまたいで変化しないため、effect の再実行
 * タイミングという意味での挙動は変わらない。
 */
export function useAppKeyboardShortcuts(params: AppKeyboardShortcutsParams): void {
  const {
    helpOpen,
    tunnelModalOpen,
    chatOpen,
    searchOpen,
    sessionListOpen,
    shortcutsOpen,
    selectedTicketId,
    onOpenSearch,
    onOpenShortcuts,
    onCloseShortcuts,
  } = params;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (!isModifier || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key !== 'k' && event.key !== 'K') {
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      if (helpOpen || tunnelModalOpen) {
        return;
      }

      event.preventDefault();
      onOpenSearch();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [helpOpen, tunnelModalOpen, onOpenSearch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '?') {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      if (shortcutsOpen) {
        event.preventDefault();
        onCloseShortcuts();
        return;
      }

      if (
        searchOpen ||
        helpOpen ||
        chatOpen ||
        sessionListOpen ||
        tunnelModalOpen ||
        selectedTicketId !== null
      ) {
        return;
      }

      event.preventDefault();
      onOpenShortcuts();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    chatOpen,
    helpOpen,
    onCloseShortcuts,
    onOpenShortcuts,
    searchOpen,
    sessionListOpen,
    tunnelModalOpen,
    selectedTicketId,
    shortcutsOpen,
  ]);
}
