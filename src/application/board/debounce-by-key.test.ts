import { afterEach, describe, expect, it, vi } from 'vitest';
import { debounceByKey } from './debounce-by-key.js';

describe('debounceByKey', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses repeated triggers on the same key into one call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounceByKey(fn, 100);

    debounced.trigger('a');
    debounced.trigger('a');
    debounced.trigger('a');
    debounced.trigger('a');
    debounced.trigger('a');

    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('extends the wait when triggered again before the delay elapses', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounceByKey(fn, 100);

    debounced.trigger('a');
    vi.advanceTimersByTime(50);
    debounced.trigger('a');
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires independently for different keys', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounceByKey(fn, 100);

    debounced.trigger('a');
    debounced.trigger('b');
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'a');
    expect(fn).toHaveBeenNthCalledWith(2, 'b');
  });

  it('does not fire after cancel even when time advances', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounceByKey(fn, 100);

    debounced.trigger('a');
    debounced.cancel();
    vi.advanceTimersByTime(200);

    expect(fn).not.toHaveBeenCalled();
  });

  it('fires again after a completed debounce cycle', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounceByKey(fn, 100);

    debounced.trigger('a');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    debounced.trigger('a');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
