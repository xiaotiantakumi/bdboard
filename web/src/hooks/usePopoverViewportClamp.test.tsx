import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePopoverViewportClamp } from './usePopoverViewportClamp';

const POPOVER_VIEWPORT_GUTTER_RATIO = 0.02;
const POPOVER_VIEWPORT_GUTTER_MIN_PX = 12;

function gutterForViewport(viewportWidth: number): number {
  return Math.max(POPOVER_VIEWPORT_GUTTER_MIN_PX, viewportWidth * POPOVER_VIEWPORT_GUTTER_RATIO);
}

function PopoverProbe({ open }: { open: boolean }) {
  const ref = usePopoverViewportClamp<HTMLDivElement>(open);
  return <div ref={ref} data-testid="popover" />;
}

function SwappablePopoverProbe({ open, mounted }: { open: boolean; mounted: boolean }) {
  const ref = usePopoverViewportClamp<HTMLDivElement>(open);
  return mounted ? <div ref={ref} data-testid="popover" /> : null;
}

function stubClientWidth(width: number) {
  return vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(width);
}

function stubBoundingRect(rect: Pick<DOMRect, 'left' | 'right'>) {
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

describe('usePopoverViewportClamp', () => {
  let clientWidthSpy: ReturnType<typeof stubClientWidth> | undefined;
  let rectSpy: ReturnType<typeof stubBoundingRect> | undefined;

  beforeEach(() => {
    document.documentElement.style.removeProperty('--popover-shift-x');
  });

  afterEach(() => {
    clientWidthSpy?.mockRestore();
    rectSpy?.mockRestore();
    clientWidthSpy = undefined;
    rectSpy = undefined;
  });

  it('shifts right when the popover overflows the left edge', () => {
    const viewportWidth = 375;
    clientWidthSpy = stubClientWidth(viewportWidth);
    rectSpy = stubBoundingRect({ left: -87, right: 250 });

    const { getByTestId } = render(<PopoverProbe open />);
    const popover = getByTestId('popover');
    const shift = popover.style.getPropertyValue('--popover-shift-x');
    const shiftPx = Number.parseFloat(shift);
    const gutter = gutterForViewport(viewportWidth);

    expect(shift).not.toBe('');
    expect(shiftPx).toBeGreaterThan(0);
    expect(-87 + shiftPx).toBeGreaterThanOrEqual(gutter);
  });

  it('keeps --popover-shift-x at 0px when the popover already fits', () => {
    clientWidthSpy = stubClientWidth(1280);
    rectSpy = stubBoundingRect({ left: 900, right: 1240 });

    const { getByTestId } = render(<PopoverProbe open />);
    expect(getByTestId('popover').style.getPropertyValue('--popover-shift-x')).toBe('0px');
  });

  it('shifts left when the popover overflows the right edge', () => {
    const viewportWidth = 1280;
    clientWidthSpy = stubClientWidth(viewportWidth);
    rectSpy = stubBoundingRect({ left: 100, right: 1300 });

    const { getByTestId } = render(<PopoverProbe open />);
    const popover = getByTestId('popover');
    const shiftPx = Number.parseFloat(popover.style.getPropertyValue('--popover-shift-x'));
    const gutter = gutterForViewport(viewportWidth);

    expect(shiftPx).toBeLessThan(0);
    expect(1300 + shiftPx).toBeLessThanOrEqual(viewportWidth - gutter);
  });

  it('does not write --popover-shift-x while closed', () => {
    clientWidthSpy = stubClientWidth(375);
    rectSpy = stubBoundingRect({ left: -87, right: 250 });

    const { getByTestId } = render(<PopoverProbe open={false} />);
    expect(getByTestId('popover').style.getPropertyValue('--popover-shift-x')).toBe('');
  });

  // Mimics AiQuotaWidget fetch error → recovery: popoverOpen stays true while the DOM node is removed and recreated.
  it('re-clamps a popover node that is remounted while open', () => {
    const viewportWidth = 375;
    clientWidthSpy = stubClientWidth(viewportWidth);
    rectSpy = stubBoundingRect({ left: -87, right: 250 });

    const { getByTestId, queryByTestId, rerender } = render(
      <SwappablePopoverProbe open mounted />,
    );

    const firstPopover = getByTestId('popover');
    const firstShift = firstPopover.style.getPropertyValue('--popover-shift-x');
    expect(Number.parseFloat(firstShift)).toBeGreaterThan(0);

    rerender(<SwappablePopoverProbe open mounted={false} />);
    expect(queryByTestId('popover')).toBeNull();

    rerender(<SwappablePopoverProbe open mounted />);
    const remountedPopover = getByTestId('popover');
    expect(remountedPopover).not.toBe(firstPopover);

    const remountedShift = remountedPopover.style.getPropertyValue('--popover-shift-x');
    expect(remountedShift).not.toBe('');
    expect(Number.parseFloat(remountedShift)).toBeGreaterThan(0);
  });

  it('keeps --popover-shift-x on the same node across rerenders while open', () => {
    clientWidthSpy = stubClientWidth(375);
    rectSpy = stubBoundingRect({ left: -87, right: 250 });

    const { getByTestId, rerender } = render(<PopoverProbe open />);
    const popover = getByTestId('popover');
    const shiftBefore = popover.style.getPropertyValue('--popover-shift-x');

    rerender(<PopoverProbe open />);
    expect(getByTestId('popover')).toBe(popover);
    expect(getByTestId('popover').style.getPropertyValue('--popover-shift-x')).toBe(shiftBefore);
  });
});
