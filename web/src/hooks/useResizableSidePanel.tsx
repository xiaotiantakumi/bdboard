import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../mediaQueries';
import { usePersistedState } from './usePersistedState';

const MIN_WIDTH = 360;
const MAX_WIDTH = 720;
const MIN_REMAINING_WIDTH = 320;
const RESIZE_STEP = 20;

/**
 * Layout viewport width — the same value CSS media queries use
 * (document.documentElement.clientWidth). Falls back to innerWidth when
 * clientWidth is 0 (jsdom without layout; existing unit tests only stub innerWidth).
 *
 * grep audit (bdboard-d2u6): production code had innerWidth only in clampWidth/canResize;
 * both now use clientWidth/matchMedia. E2E header-sticky / mobile-header-compact
 * intentionally keep innerWidth to assert overflow does not inflate the layout viewport.
 */
function getLayoutViewportWidth(): number {
  if (typeof window === 'undefined') return 0;
  const clientWidth = document.documentElement.clientWidth;
  return clientWidth || window.innerWidth;
}

function clampWidth(width: number): number {
  const viewportWidth = getLayoutViewportWidth();
  const viewportMaximum = Math.max(MIN_WIDTH, viewportWidth - MIN_REMAINING_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH, viewportMaximum));
}

/**
 * Resize is allowed only above the mobile breakpoint, where index.css hides
 * .side-panel-resize-handle. Uses matchMedia so JS agrees with CSS even when
 * horizontal overflow inflates window.innerWidth.
 */
function canResize(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return !window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches;
  }
  return getLayoutViewportWidth() > 700;
}

export function validateSidePanelWidth(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_WIDTH && value <= MAX_WIDTH
    ? value
    : null;
}

interface DragStart {
  pointerX: number;
  startWidth: number;
}

export function useResizableSidePanel(storageKey: string, defaultWidth = 480) {
  const [persistedWidth, setPersistedWidth] = usePersistedState(storageKey, defaultWidth, validateSidePanelWidth);
  const [isResizing, setIsResizing] = useState(false);
  // ドラッグ中の見た目の幅。pointermoveのたびにここだけを更新し、
  // localStorageへの書き込み(usePersistedStateのsetter)はpointerup/pointercancel
  // 時に1回だけ行う。60Hz超で発火しうるpointermoveごとにsetItemすると
  // クロスタブへのstorageイベント発火が同頻度で起き、他タブのパネルまで
  // ドラッグ周波数で再レンダーされてしまうため。
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const dragStartRef = useRef<DragStart | null>(null);

  const width = draftWidth ?? persistedWidth;
  const effectiveWidth = clampWidth(width);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canResize()) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    // ドラッグ開始位置と開始時点の実効幅を記録し、以降はカーソルの移動量(差分)
    // だけを現在の幅に加算する。開始時点でカーソル位置から幅を再計算すると、
    // ハンドルの位置とカーソル位置がわずかにずれているだけで幅が瞬間的に
    // 跳んでしまう。
    dragStartRef.current = { pointerX: event.clientX, startWidth: effectiveWidth };
    setIsResizing(true);
    setDraftWidth(effectiveWidth);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isResizing || dragStartRef.current === null) return;
    const { pointerX, startWidth } = dragStartRef.current;
    // パネルは右側にあるため、カーソルが左に動く(clientXが減る)ほど幅は増える。
    const delta = pointerX - event.clientX;
    setDraftWidth(clampWidth(startWidth + delta));
  };
  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    setIsResizing(false);
    dragStartRef.current = null;
    if (draftWidth !== null) {
      setPersistedWidth(draftWidth);
    }
    setDraftWidth(null);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canResize()) return;
    const nextWidth =
      event.key === 'ArrowLeft' ? effectiveWidth + RESIZE_STEP :
      event.key === 'ArrowRight' ? effectiveWidth - RESIZE_STEP :
      event.key === 'Home' ? MIN_WIDTH :
      event.key === 'End' ? MAX_WIDTH : undefined;
    if (nextWidth !== undefined) {
      event.preventDefault();
      // キーボード操作は連打でも60Hzには達しないため、従来どおり操作ごとに即座に永続化する。
      setPersistedWidth(clampWidth(nextWidth));
    }
  };

  return {
    width,
    effectiveWidth,
    maximumWidth: clampWidth(MAX_WIDTH),
    isResizing,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    handleKeyDown,
  };
}

export function SidePanelResizeHandle({
  label,
  panel,
}: {
  label: string;
  panel: ReturnType<typeof useResizableSidePanel>;
}) {
  return (
    <div
      className="side-panel-resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={panel.maximumWidth}
      aria-valuenow={panel.effectiveWidth}
      tabIndex={0}
      onPointerDown={panel.handlePointerDown}
      onPointerMove={panel.handlePointerMove}
      onPointerUp={panel.handlePointerEnd}
      onPointerCancel={panel.handlePointerEnd}
      onKeyDown={panel.handleKeyDown}
    />
  );
}
