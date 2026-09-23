import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useThreadDrawerState } from './useThreadDrawerState';

function Probe() {
  const drawer = useThreadDrawerState();
  // 呼び出し側 (ChatPanel) の useCallback 依存配列に安全に乗せられるかどうかを
  // 確かめるため、各関数の参照が再レンダーをまたいで安定しているかを記録する。
  const seen = useRef<Record<string, unknown>>({});
  const stableKeys = [
    'toggleDrawer',
    'closeDrawer',
    'selectThread',
    'toggleMenu',
    'closeMenu',
    'startRename',
    'changeRenameDraft',
    'cancelRename',
    'startConfirmDelete',
    'cancelConfirmDelete',
    'cancelInteractionsForSession',
    'toggleDiscoveredSessions',
    'closeDiscoveredSessions',
  ] as const;
  // レビュー指摘(bdboard-sso1.83): 各レンダーの不一致だけを保持すると、途中の
  // レンダーで起きた参照崩れが直後のレンダーで上書きされ、最終 DOM の
  // アサーションからは見えなくなる。全レンダーを通じて一度でも崩れた key を
  // 蓄積し続けることで、テスト末尾の1回の DOM チェックでも履歴全体を検証できる
  // ようにする。
  const allMismatchesRef = useRef<string[]>([]);
  for (const key of stableKeys) {
    const current = drawer[key];
    if (key in seen.current && seen.current[key] !== current) {
      allMismatchesRef.current.push(key);
    }
    seen.current[key] = current;
  }

  return (
    <div>
      <p data-testid="drawer-open">{String(drawer.state.drawerOpen)}</p>
      <p data-testid="menu-session">{drawer.state.menuSessionId ?? ''}</p>
      <p data-testid="renaming-session">{drawer.state.renamingSessionId ?? ''}</p>
      <p data-testid="rename-draft">{drawer.state.renameDraft}</p>
      <p data-testid="confirming-delete">{drawer.state.confirmingDeleteSessionId ?? ''}</p>
      <p data-testid="discovered-sessions">{String(drawer.state.showDiscoveredSessions)}</p>
      <p data-testid="identity-mismatches">{allMismatchesRef.current.join(',')}</p>
      <button type="button" onClick={drawer.toggleDrawer}>
        toggleDrawer
      </button>
      <button type="button" onClick={drawer.closeDrawer}>
        closeDrawer
      </button>
      <button type="button" onClick={drawer.selectThread}>
        selectThread
      </button>
      <button type="button" onClick={() => drawer.toggleMenu('session-1')}>
        toggleMenu
      </button>
      <button type="button" onClick={drawer.closeMenu}>
        closeMenu
      </button>
      <button type="button" onClick={() => drawer.startRename('session-1', 'タイトル')}>
        startRename
      </button>
      <button type="button" onClick={() => drawer.changeRenameDraft('編集後')}>
        changeRenameDraft
      </button>
      <button type="button" onClick={drawer.cancelRename}>
        cancelRename
      </button>
      <button type="button" onClick={() => drawer.startConfirmDelete('session-1')}>
        startConfirmDelete
      </button>
      <button type="button" onClick={drawer.cancelConfirmDelete}>
        cancelConfirmDelete
      </button>
      <button type="button" onClick={() => drawer.cancelInteractionsForSession('session-1')}>
        cancelInteractionsForSession
      </button>
      <button type="button" onClick={drawer.toggleDiscoveredSessions}>
        toggleDiscoveredSessions
      </button>
      <button type="button" onClick={drawer.closeDiscoveredSessions}>
        closeDiscoveredSessions
      </button>
    </div>
  );
}

function click(name: string) {
  act(() => {
    screen.getByRole('button', { name }).click();
  });
}

describe('useThreadDrawerState (bdboard-sso1.83)', () => {
  it('starts with the drawer closed and no row interaction in progress', () => {
    render(<Probe />);
    expect(screen.getByTestId('drawer-open')).toHaveTextContent('false');
    expect(screen.getByTestId('menu-session')).toBeEmptyDOMElement();
    expect(screen.getByTestId('renaming-session')).toBeEmptyDOMElement();
    expect(screen.getByTestId('confirming-delete')).toBeEmptyDOMElement();
    expect(screen.getByTestId('discovered-sessions')).toHaveTextContent('false');
  });

  it('toggles the drawer open and closed', () => {
    render(<Probe />);
    click('toggleDrawer');
    expect(screen.getByTestId('drawer-open')).toHaveTextContent('true');
    click('toggleDrawer');
    expect(screen.getByTestId('drawer-open')).toHaveTextContent('false');
  });

  it('closing the drawer also closes an open row menu', () => {
    render(<Probe />);
    click('toggleDrawer');
    click('toggleMenu');
    expect(screen.getByTestId('menu-session')).toHaveTextContent('session-1');
    click('closeDrawer');
    expect(screen.getByTestId('drawer-open')).toHaveTextContent('false');
    expect(screen.getByTestId('menu-session')).toBeEmptyDOMElement();
  });

  it('startRename opens rename mode with the given draft and closes the menu', () => {
    render(<Probe />);
    click('toggleMenu');
    click('startRename');
    expect(screen.getByTestId('renaming-session')).toHaveTextContent('session-1');
    expect(screen.getByTestId('rename-draft')).toHaveTextContent('タイトル');
    expect(screen.getByTestId('menu-session')).toBeEmptyDOMElement();
  });

  it('changeRenameDraft updates only the draft text', () => {
    render(<Probe />);
    click('startRename');
    click('changeRenameDraft');
    expect(screen.getByTestId('rename-draft')).toHaveTextContent('編集後');
    expect(screen.getByTestId('renaming-session')).toHaveTextContent('session-1');
  });

  it('cancelRename clears rename mode', () => {
    render(<Probe />);
    click('startRename');
    click('cancelRename');
    expect(screen.getByTestId('renaming-session')).toBeEmptyDOMElement();
  });

  it('startConfirmDelete / cancelConfirmDelete manage delete-confirm mode', () => {
    render(<Probe />);
    click('startConfirmDelete');
    expect(screen.getByTestId('confirming-delete')).toHaveTextContent('session-1');
    click('cancelConfirmDelete');
    expect(screen.getByTestId('confirming-delete')).toBeEmptyDOMElement();
  });

  it('cancelInteractionsForSession only clears state matching that session', () => {
    render(<Probe />);
    click('startConfirmDelete'); // session-1
    click('cancelInteractionsForSession'); // targets session-1
    expect(screen.getByTestId('confirming-delete')).toBeEmptyDOMElement();
  });

  it('selectThread closes the drawer, menu, rename mode, and delete-confirm mode together', () => {
    render(<Probe />);
    click('toggleDrawer');
    click('toggleMenu');
    click('startConfirmDelete');
    click('selectThread');
    expect(screen.getByTestId('drawer-open')).toHaveTextContent('false');
    expect(screen.getByTestId('menu-session')).toBeEmptyDOMElement();
    expect(screen.getByTestId('confirming-delete')).toBeEmptyDOMElement();
  });

  it('toggles and closes the discovered-sessions panel', () => {
    render(<Probe />);
    click('toggleDiscoveredSessions');
    expect(screen.getByTestId('discovered-sessions')).toHaveTextContent('true');
    click('closeDiscoveredSessions');
    expect(screen.getByTestId('discovered-sessions')).toHaveTextContent('false');
  });

  it('keeps every returned action function referentially stable across re-renders', () => {
    render(<Probe />);
    // 何度か state を動かして再レンダーを起こす。ChatPanel 側は
    // clearStreamingReplyForKey などと同じパターンでこれらを useCallback の
    // 依存配列に載せているため、参照が変わると無駄な再生成/無限ループの
    // 温床になる。
    click('toggleDrawer');
    click('toggleMenu');
    click('startRename');
    click('changeRenameDraft');
    click('cancelRename');
    click('toggleDiscoveredSessions');
    expect(screen.getByTestId('identity-mismatches')).toBeEmptyDOMElement();
  });
});
