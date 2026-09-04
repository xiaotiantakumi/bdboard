import path from 'node:path';

const chains = new Map<string, Promise<unknown>>();

/** Serializes read-merge-write cycles for the same config file within one process. */
export function withConfigFileLock<T>(
  filePath: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const key = path.resolve(filePath);
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
