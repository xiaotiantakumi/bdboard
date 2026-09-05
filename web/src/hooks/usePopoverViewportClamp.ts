import { useLayoutEffect, useState } from 'react';

// Viewport-relative gutter avoids hard-coded px that diverge across breakpoints.
export const POPOVER_VIEWPORT_GUTTER_RATIO = 0.02;
// Ratio-only gutters shrink on narrow viewports (320px→6.4px) where margin matters most;
// align with repo conventions (.undo-snackbar uses calc(100vw - 32px), etc.).
export const POPOVER_VIEWPORT_GUTTER_MIN_PX = 12;
// ガターが .header の左右パディング（web/src/index.css の calc(20px + env(safe-area-inset-*))。
// .view-toolbar 自身に左右パディングは無く、width:100% でその内側に敷かれているだけ）を
// 上回ると、usePopoverViewportClamp がレイアウト上の内側インセットと喧嘩し、実際には
// はみ出していないポップオーバーまで動かす
// （1280px で ±5.6px の偽陽性シフト。bdboard-s0o7 / bdboard-hovk PR #318）。
// 天井をパディングの素の値と同じ 20px に置き結合を固定する。この結合が腐ると e2e が落ちる。
// 前提: MIN < MAX。逆転させると下の Math.min が勝ち、狭幅の床 12px が無言で消える。
export const POPOVER_VIEWPORT_GUTTER_MAX_PX = 20;

function clampPopoverToViewport(el: HTMLElement): void {
  el.style.setProperty('--popover-shift-x', '0px');

  const rect = el.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const gutter = Math.min(
    POPOVER_VIEWPORT_GUTTER_MAX_PX,
    Math.max(POPOVER_VIEWPORT_GUTTER_MIN_PX, viewportWidth * POPOVER_VIEWPORT_GUTTER_RATIO),
  );

  let shift = 0;
  if (rect.right > viewportWidth - gutter) {
    shift = viewportWidth - gutter - rect.right;
  }
  if (rect.left + shift < gutter) {
    shift = gutter - rect.left;
  }

  el.style.setProperty('--popover-shift-x', `${shift}px`);
}

/**
 * Horizontally shifts a popover via --popover-shift-x so it stays within the
 * viewport. Pair with `transform: translateX(var(--popover-shift-x, 0px))`.
 *
 * --popover-shift-x is inherited by descendants; the CSS fallback `0px` only
 * applies when unset, so a nested popover could inherit a parent's shift and
 * double-apply translateX until its own clampPopoverToViewport run sets `0px`.
 *
 * Returns a callback ref (not RefObject) so layout effect re-runs when the DOM
 * node is replaced while `open` stays true — e.g. AiQuotaWidget keeps
 * popoverOpen but unmounts the popover on fetch error and remounts on recovery.
 */
export function usePopoverViewportClamp<T extends HTMLElement>(
  open: boolean,
): (element: T | null) => void {
  const [element, setElement] = useState<T | null>(null);

  useLayoutEffect(() => {
    if (!open || element === null) {
      return;
    }

    const recalculate = () => {
      clampPopoverToViewport(element);
    };

    recalculate();

    window.addEventListener('resize', recalculate);
    window.addEventListener('orientationchange', recalculate);

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(recalculate);
      resizeObserver.observe(element);
    }

    return () => {
      window.removeEventListener('resize', recalculate);
      window.removeEventListener('orientationchange', recalculate);
      resizeObserver?.disconnect();
      element.style.setProperty('--popover-shift-x', '0px');
    };
  }, [open, element]);

  return setElement;
}
