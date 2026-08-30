import { useCallback, useEffect, useRef, useState } from 'react';
import { boardHashTarget, parseBoardHash, type BoardHashState } from '../boardHash';
import type { ViewMode } from '../uiPersistedState';

export interface UseTicketDeepLinkOptions {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
}

export interface TicketDeepLink {
  selectedTicketId: string | null;
  selectTicket: (ticketId: string) => void;
  closeDetail: () => void;
  /** 詳細パネル内で1つ前に見ていたチケットへ戻れるか (bdboard-4ql7) */
  canGoBackTicket: boolean;
  /** 詳細パネル内の履歴を1つ戻る。戻り先が無ければ何もしない */
  goBackTicket: () => void;
}

function readHistoryState(): Record<string, unknown> {
  const state = window.history.state;
  if (state !== null && typeof state === 'object') {
    return { ...(state as Record<string, unknown>) };
  }
  return {};
}

export function useTicketDeepLink({
  view,
  onViewChange,
}: UseTicketDeepLinkOptions): TicketDeepLink {
  // Parsed once, on the first render only: the hash is re-read from then on by
  // the popstate/hashchange listener, never by re-parsing during render.
  const initialHashRef = useRef<BoardHashState | null>(null);
  if (initialHashRef.current === null) {
    initialHashRef.current = parseBoardHash(window.location.hash);
  }
  const initialHash = initialHashRef.current;

  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(
    () => initialHash.ticketId,
  );
  /*
   * 詳細パネル内のチケット遷移履歴 (bdboard-4ql7)。
   *
   * ブラウザ履歴ではなくアプリ内スタックで持つ。selectTicket はチケット→チケット
   * 遷移で replaceState する (履歴エントリを増やさない) 設計で、ブラウザの戻るは
   * 「詳細パネルを閉じる」に割り当てられている。ここで pushState に変えると
   * closeDetail の history.back() が1つ前のチケットへ戻ってしまい、閉じる操作が
   * 壊れる — 深さを数える必要が出てブラウザ履歴との同期が複雑になる
   * (bdboard-ge1 で popstate 周りの取り違えが実際にバグになっている)。
   *
   * よってブラウザ履歴の意味は一切変えず、パネル内の「戻る」だけを別に持つ。
   */
  const [backStack, setBackStack] = useState<readonly string[]>([]);
  /*
   * backStack のミラー。goBackTicket は「戻り先を読む」→「history と表示を
   * 差し替える」→「スタックを1つ削る」の順で副作用を含むので、setBackStack の
   * updater 内でそれをやると updater が純粋でなくなる。React は updater を
   * 再実行しうる (StrictMode の development 二重実行、並行レンダリング) ため、
   * 契約違反のまま置くと将来の React で壊れる。bdboard-ge1 が
   * 「development の二重実行 × history API」で実際に刺さった前例なので、
   * ref から読んでハンドラ本体で副作用を済ませ、updater は純粋に保つ。
   */
  const backStackRef = useRef<readonly string[]>(backStack);
  backStackRef.current = backStack;
  const pendingHashViewRef = useRef<ViewMode | null>(initialHash.view);
  const detailPushedRef = useRef(false);
  const selectedTicketIdRef = useRef<string | null>(initialHash.ticketId);

  const viewRef = useRef(view);
  viewRef.current = view;

  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  selectedTicketIdRef.current = selectedTicketId;

  // Apply view from the initial hash without letting the sync effect overwrite it
  // with the stale persisted view (merged) first.
  useEffect(() => {
    const pending = pendingHashViewRef.current;
    if (pending === null) {
      return;
    }
    if (pending === view) {
      pendingHashViewRef.current = null;
      return;
    }
    onViewChangeRef.current(pending);
  }, [view]);

  // Keep the URL hash in sync (replaceState only — no extra history entries).
  useEffect(() => {
    const effectiveView = pendingHashViewRef.current ?? view;
    const target = boardHashTarget(
      { ticketId: selectedTicketId, view: effectiveView },
      window.location,
    );
    const current =
      window.location.pathname + window.location.search + window.location.hash;
    if (target === current) {
      return;
    }
    window.history.replaceState(window.history.state, '', target);
  }, [view, selectedTicketId]);

  const selectTicket = useCallback((ticketId: string) => {
    const previous = selectedTicketIdRef.current;
    if (previous !== null && previous !== ticketId) {
      setBackStack((stack) => [...stack, previous]);
    }

    const target = boardHashTarget(
      { ticketId, view: viewRef.current },
      window.location,
    );
    const state = { ...readHistoryState(), ticketId };

    if (previous === null) {
      window.history.pushState(state, '', target);
      detailPushedRef.current = true;
    } else {
      window.history.replaceState(state, '', target);
    }
    setSelectedTicketId(ticketId);
  }, []);

  const goBackTicket = useCallback(() => {
    const stack = backStackRef.current;
    const previous = stack[stack.length - 1];
    if (previous === undefined) {
      return;
    }
    // selectTicket と違いスタックは積まない (戻る操作なので)。履歴エントリも
    // 増やさず、今のエントリを戻り先のチケットで置き換える。
    const target = boardHashTarget(
      { ticketId: previous, view: viewRef.current },
      window.location,
    );
    window.history.replaceState(
      { ...readHistoryState(), ticketId: previous },
      '',
      target,
    );
    // 同一イベント内で goBackTicket が2回呼ばれても正しく2段戻れるように、
    // ref も即座に進めておく (state 更新は次のレンダーまで反映されないため)。
    backStackRef.current = stack.slice(0, -1);
    setSelectedTicketId(previous);
    setBackStack((current) => current.slice(0, -1));
  }, []);

  const closeDetail = useCallback(() => {
    setBackStack([]);
    backStackRef.current = [];
    if (detailPushedRef.current) {
      window.history.back();
    } else {
      setSelectedTicketId(null);
    }
  }, []);

  useEffect(() => {
    const onLocationChange = () => {
      const next = parseBoardHash(window.location.hash);
      // Keep detailPushedRef true while the hash still carries a ticket — e.g.
      // when a child panel (ChatPanel / SessionListPanel via useHistoryBackClose)
      // pops its own entry, we must not lose track of the detail entry we pushed.
      // Previously App closed the detail panel on every popstate unconditionally,
      // which broke that case; the hash is now the source of truth.
      detailPushedRef.current =
        detailPushedRef.current && next.ticketId !== null;
      /*
       * ブラウザ操作 (戻る/進む/直リンク) で表示チケットが「変わったとき」だけ、
       * パネル内スタックを捨てる (bdboard-4ql7)。
       *
       * 無条件に捨ててはいけない。上の detailPushedRef のコメントのとおり、
       * useHistoryBackClose を使う子パネル (ChatPanel / SessionListPanel /
       * SessionTailViewer / HelpPanel / KeyboardShortcutsPanel) は自前の履歴
       * エントリを push し、閉じるときに history.back() で pop する。このとき
       * hash は #ticket=… のままで表示チケットも変わらないのに popstate は
       * 発火する。無条件クリアだと「チケットBについてチャット → チャットを
       * 閉じる」だけで戻る先を失う。表示が変わらないなら履歴との対応も
       * 壊れていないので、スタックは保持してよい。
       */
      if (next.ticketId !== selectedTicketIdRef.current) {
        setBackStack([]);
        backStackRef.current = [];
      }
      setSelectedTicketId(next.ticketId);
      if (next.view !== null && next.view !== viewRef.current) {
        onViewChangeRef.current(next.view);
      }
    };

    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
    return () => {
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('hashchange', onLocationChange);
    };
  }, []);

  return {
    selectedTicketId,
    selectTicket,
    closeDetail,
    canGoBackTicket: backStack.length > 0,
    goBackTicket,
  };
}
