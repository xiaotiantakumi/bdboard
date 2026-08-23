import { type KeyboardEvent, type PointerEvent, useState } from 'react';
import { usePersistedState } from './usePersistedState';

const MIN_WIDTH = 360;
const MAX_WIDTH = 720;
const MIN_REMAINING_WIDTH = 320;
const RESIZE_STEP = 20;

function clampWidth(width: number): number {
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const viewportMaximum = Math.max(MIN_WIDTH, viewportWidth - MIN_REMAINING_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH, viewportMaximum));
}

function canResize(): boolean {
  return typeof window !== 'undefined' && window.innerWidth > 700;
}

export function validateSidePanelWidth(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_WIDTH && value <= MAX_WIDTH
    ? value
    : null;
}

export function useResizableSidePanel(storageKey: string, defaultWidth = 480) {
  const [width, setWidth] = usePersistedState(storageKey, defaultWidth, validateSidePanelWidth);
  const [isResizing, setIsResizing] = useState(false);
  const effectiveWidth = clampWidth(width);

  const updateWidth = (nextWidth: number) => setWidth(clampWidth(nextWidth));

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canResize()) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
    updateWidth(window.innerWidth - event.clientX);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (isResizing) updateWidth(window.innerWidth - event.clientX);
  };
  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    setIsResizing(false);
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
      updateWidth(nextWidth);
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
