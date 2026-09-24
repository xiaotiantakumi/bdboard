import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './messages';
import { useStickToBottomScroll } from './useStickToBottomScroll';

// クランプ付き scrollTop / 動的な scrollHeight を持つ、実ブラウザの挙動に近い
// スクロール領域を模す (ChatPanel.send-stream-basics.test.tsx の
// instrumentScrollArea と同じ考え方)。scrollTop への代入は実際に変化した
// ときだけ 'scroll' イベントを発火する — 変化しない代入(effect の書いた値と
// 同じ値へのプログラム的な再代入や、ユーザーが動かしていないのに届いた
// イベント)ではハンドラを起動しないのが本物のブラウザの挙動であり、
// bdboard-dtr の冪等判定はこの前提の上で成立する。
interface ScrollArea {
  grow(height: number): void;
  scrollBy(delta: number): void;
  readonly top: number;
}

function instrument(element: HTMLElement, clientHeight: number, initialScrollHeight: number): ScrollArea {
  let scrollTop = 0;
  let scrollHeight = initialScrollHeight;
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => {
      const max = Math.max(0, scrollHeight - clientHeight);
      const clamped = Math.max(0, Math.min(next, max));
      if (clamped === scrollTop) {
        return;
      }
      scrollTop = clamped;
      element.dispatchEvent(new Event('scroll'));
    },
  });
  return {
    grow(height: number) {
      scrollHeight = height;
    },
    scrollBy(delta: number) {
      // 直接 scrollTop を書き換える (= 実ブラウザで利用者がスクロールしたのと
      // 同じ経路。setter を通るので clamp と 'scroll' 発火が起きる)。
      element.scrollTop = scrollTop + delta;
    },
    get top() {
      return scrollTop;
    },
  };
}

interface ProbeProps {
  resetKey: string;
  messages: readonly ChatMessage[];
  onArea: (area: ScrollArea) => void;
}

function Probe({ resetKey, messages, onArea }: ProbeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const attached = useRef(false);
  const setContainer = (element: HTMLDivElement | null) => {
    containerRef.current = element;
    if (element !== null && !attached.current) {
      attached.current = true;
      // clientHeight 50, 初期 scrollHeight 200 (=末尾まで 150px 分のコンテンツ)。
      onArea(instrument(element, 50, 200));
    }
  };
  const { onScroll } = useStickToBottomScroll(containerRef, resetKey, messages, false, '');
  return <div ref={setContainer} data-testid="scroll" onScroll={onScroll} />;
}

const EMPTY_MESSAGES: ChatMessage[] = [];
const GROWN_MESSAGES: ChatMessage[] = [{ role: 'user', text: 'hi', at: 1 }];

describe('useStickToBottomScroll', () => {
  it('stays pinned at exactly the 48px threshold and snaps to the new bottom on the next update', () => {
    let area!: ScrollArea;
    const { rerender } = render(
      <Probe resetKey="one" messages={EMPTY_MESSAGES} onArea={(a) => { area = a; }} />,
    );
    // マウント時の追従 effect が最下部(200 - 50 = 150)へ貼り付ける。
    expect(area.top).toBe(150);

    // 利用者が 48px だけ上へスクロール(= 境界値のちょうど内側)。
    act(() => area.scrollBy(-48));
    expect(area.top).toBe(102);

    // 新着メッセージでコンテンツが伸び、messages の参照が変わって追従
    // effect が再実行される。48px は「貼り付いている」とみなす境界の
    // 内側なので、新しい最下部(260 - 50 = 210)へ再度貼り付く。
    area.grow(260);
    rerender(<Probe resetKey="one" messages={GROWN_MESSAGES} onArea={(a) => { area = a; }} />);
    expect(area.top).toBe(210);
  });

  it('unpins just past the 48px threshold and stops following on later updates', () => {
    let area!: ScrollArea;
    const { rerender } = render(
      <Probe resetKey="one" messages={EMPTY_MESSAGES} onArea={(a) => { area = a; }} />,
    );
    expect(area.top).toBe(150);

    // 49px は境界の外側。追従をやめる。
    act(() => area.scrollBy(-49));
    expect(area.top).toBe(101);

    // その後コンテンツが伸びて messages が変わっても、追従していないので
    // scrollTop は利用者が止めた位置のまま動かない。
    area.grow(260);
    rerender(<Probe resetKey="one" messages={GROWN_MESSAGES} onArea={(a) => { area = a; }} />);
    expect(area.top).toBe(101);
  });

  it('ignores a delayed scroll echo that arrives after the area grew (bdboard-dtr)', () => {
    let area!: ScrollArea;
    const { rerender } = render(
      <Probe resetKey="one" messages={EMPTY_MESSAGES} onArea={(a) => { area = a; }} />,
    );
    // マウント時点で貼り付き、マーカーは 150。
    expect(area.top).toBe(150);

    // コンテンツだけ先に伸びる (delta 到着で DOM は伸びたが、まだ effect も
    // 利用者操作も無い状態を模す)。scrollTop はまだ古いまま(150)。
    area.grow(260);
    // ここで scrollTop を動かさずに 'scroll' イベントだけ飛ぶ状況を再現する
    // (実ブラウザでイベントが遅延して届く場合に相当)。値を変えない代入は
    // instrument() の setter が 'scroll' を発火しないので、直接 dispatch する。
    act(() => {
      (
        document.querySelector('[data-testid="scroll"]') as HTMLElement
      ).dispatchEvent(new Event('scroll'));
    });
    // 冪等判定によりこのイベントは無視されるはずで、追従状態は保たれている。
    // 証拠として、次の messages 変化で新しい最下部(260 - 50 = 210)へ
    // 貼り付くことを確認する — 冪等判定が無ければこのイベントで
    // distanceFromBottom = 260 - 150 - 50 = 60 > 48 と誤判定され、
    // pinnedToBottomRef が false に落ちて以降ここへは辿り着けない。
    rerender(<Probe resetKey="one" messages={GROWN_MESSAGES} onArea={(a) => { area = a; }} />);
    expect(area.top).toBe(210);
  });

  it('re-pins to the bottom when resetKey changes, overriding a prior manual scroll-up (bdboard-22k)', () => {
    let area!: ScrollArea;
    const { rerender } = render(
      <Probe resetKey="one" messages={EMPTY_MESSAGES} onArea={(a) => { area = a; }} />,
    );
    expect(area.top).toBe(150);

    // 49px 上へスクロールして追従を止める。
    act(() => area.scrollBy(-49));
    expect(area.top).toBe(101);

    // resetKey だけを変える(messages はまだ同じ参照)。リセット effect は
    // 追従 effect より前に登録されているので同じコミットで先に走るが、
    // 追従 effect 自体は deps([messages, isSending, streamingText])が
    // 変わっていないので再実行されない — まだ scrollTop は動かない。
    rerender(<Probe resetKey="two" messages={EMPTY_MESSAGES} onArea={(a) => { area = a; }} />);
    expect(area.top).toBe(101);

    // messages を変えて追従 effect を起動する。リセットで
    // pinnedToBottomRef が true に戻っているので、直前まで上にいたにも
    // かかわらず最下部(150)へ貼り付き直す。
    rerender(<Probe resetKey="two" messages={GROWN_MESSAGES} onArea={(a) => { area = a; }} />);
    expect(area.top).toBe(150);
  });
});
