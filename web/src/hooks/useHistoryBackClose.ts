import { useCallback, useEffect, useRef } from 'react';

const PANEL_STATE_KEY = 'bdboardPanel';
const PANEL_TOKEN_KEY = 'bdboardPanelToken';

/** history.state に載せる bdboard パネル識別子 */
export type BdboardPanelHistoryState = Record<string, unknown> & {
  bdboardPanel?: string;
  bdboardPanelToken?: string;
};

function readHistoryState(): Record<string, unknown> {
  const state = window.history.state;
  if (state !== null && typeof state === 'object') {
    return { ...(state as Record<string, unknown>) };
  }
  return {};
}

export interface UseHistoryBackCloseOptions {
  panelId: string;
  onClose: () => void;
  enabled?: boolean;
}

/**
 * モーダルパネルを history エントリと連動させ、戻るジェスチャーで閉じられるようにする。
 * UI から閉じるときは requestClose() を使い、積んだエントリを消費する。
 */
export function useHistoryBackClose({
  panelId,
  onClose,
  enabled = true,
}: UseHistoryBackCloseOptions): { requestClose: () => void } {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 自分が pushState で積んだエントリがまだ history スタック上に残っているか
  const pushedRef = useRef(false);
  // onClose を既に呼んだか（二重クローズ防止）
  const closedRef = useRef(false);
  // インスタンスごとに一意。リロード後の古い履歴エントリと取り違えないため
  const tokenRef = useRef('');
  if (tokenRef.current === '') {
    tokenRef.current = `${panelId}#${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  useEffect(() => {
    if (!enabled) {
      return;
    }

    closedRef.current = false;

    if (!pushedRef.current) {
      window.history.pushState(
        {
          ...readHistoryState(),
          [PANEL_STATE_KEY]: panelId,
          [PANEL_TOKEN_KEY]: tokenRef.current,
        },
        '',
      );
      pushedRef.current = true;
    }

    const onPopState = () => {
      const state = window.history.state;
      const stillOurs =
        state !== null &&
        typeof state === 'object' &&
        (state as Record<string, unknown>)[PANEL_TOKEN_KEY] === tokenRef.current;

      if (stillOurs) {
        // 我々のエントリがまだ現在地 = 上に積まれた別エントリが pop されただけ。何もしない。
        return;
      }

      // 我々のエントリは消費された
      pushedRef.current = false;
      if (closedRef.current) {
        // requestClose 由来の back() の結果。onClose は既に呼んでいるので何もしない。
        return;
      }
      closedRef.current = true;
      onCloseRef.current();
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);

      if (pushedRef.current) {
        pushedRef.current = false;
        window.history.back();
      }
    };
  }, [enabled, panelId]);

  const requestClose = useCallback(() => {
    if (closedRef.current) {
      return;
    }

    closedRef.current = true;
    onCloseRef.current();

    if (pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    }
  }, []);

  return { requestClose };
}
