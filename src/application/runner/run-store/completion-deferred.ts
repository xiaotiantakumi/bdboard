import type { RunCompletionDeferred } from './types.js';

export function createCompletionDeferred(): RunCompletionDeferred {
  let resolved = false;
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve();
    };
  });
  return {
    promise,
    resolve: resolveFn,
  };
}
