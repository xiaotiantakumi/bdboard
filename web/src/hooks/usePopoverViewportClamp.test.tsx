import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePopoverViewportClamp } from './usePopoverViewportClamp';

const POPOVER_VIEWPORT_GUTTER_RATIO = 0.02;

function PopoverProbe({ open }: { open: boolean }) {
  const ref = usePopoverViewportClamp<HTMLDivElement>(open);
  return <div ref={ref} data-testid="popover" />;
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
    const gutter = viewportWidth * POPOVER_VIEWPORT_GUTTER_RATIO;

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
    const gutter = viewportWidth * POPOVER_VIEWPORT_GUTTER_RATIO;

    expect(shiftPx).toBeLessThan(0);
    expect(1300 + shiftPx).toBeLessThanOrEqual(viewportWidth - gutter);
  });

  it('does not write --popover-shift-x while closed', () => {
    clientWidthSpy = stubClientWidth(375);
    rectSpy = stubBoundingRect({ left: -87, right: 250 });

    const { getByTestId } = render(<PopoverProbe open={false} />);
    expect(getByTestId('popover').style.getPropertyValue('--popover-shift-x')).toBe('');
  });
});
