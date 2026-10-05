import { describe, expect, it } from 'vitest';
import { BD_VERSION_UNKNOWN, createBdVersionSnapshot } from './bd-version-snapshot.js';

/** then の続きが走るまで待つ (microtask を流し切る)。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createBdVersionSnapshot', () => {
  it('returns unknown until the read resolves, then returns the trimmed version', async () => {
    let resolve!: (value: string | null) => void;
    const read = new Promise<string | null>((done) => {
      resolve = done;
    });
    const version = createBdVersionSnapshot(read);
    expect(version()).toBe(BD_VERSION_UNKNOWN);
    await flush();
    expect(version()).toBe(BD_VERSION_UNKNOWN);

    resolve('  1.0.4  ');
    await flush();
    expect(version()).toBe('1.0.4');
  });

  it.each([null, '', '   '])('stays unknown when the read resolves with %j', async (value) => {
    const version = createBdVersionSnapshot(Promise.resolve(value));
    await flush();
    expect(version()).toBe(BD_VERSION_UNKNOWN);
  });

  it('stays unknown and raises no unhandled rejection when the read rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const version = createBdVersionSnapshot(Promise.reject(new Error('failed')));
      await flush();
      await flush();
      expect(version()).toBe(BD_VERSION_UNKNOWN);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
