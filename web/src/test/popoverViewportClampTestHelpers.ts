import { vi } from 'vitest';
import {
  POPOVER_VIEWPORT_GUTTER_MAX_PX,
  POPOVER_VIEWPORT_GUTTER_MIN_PX,
  POPOVER_VIEWPORT_GUTTER_RATIO,
} from '../hooks/usePopoverViewportClamp';

export function gutterForViewport(viewportWidth: number): number {
  return Math.min(
    POPOVER_VIEWPORT_GUTTER_MAX_PX,
    Math.max(POPOVER_VIEWPORT_GUTTER_MIN_PX, viewportWidth * POPOVER_VIEWPORT_GUTTER_RATIO),
  );
}

export function stubClientWidth(width: number) {
  return vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(width);
}

export function stubBoundingRect(rect: Pick<DOMRect, 'left' | 'right'>) {
  const width = rect.right - rect.left;
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: 0,
    width,
    height: 0,
    top: 0,
    right: rect.right,
    bottom: 0,
    left: rect.left,
    toJSON: () => ({}),
  });
}
