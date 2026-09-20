// Each run prompt ends with npm run verify, which acquires one of two machine-local
// verify slots — raising concurrent runs starves the operator's own verifies.
export const DEFAULT_MAX_CONCURRENT = 1;
export const DEFAULT_MAX_RETAINED_RUNS = 50;
export const DEFAULT_MAX_LOG_BYTES = 512 * 1024;

/**
 * node-streaming-command-runner.ts の STOP_GRACE_MS(3s、SIGTERM→SIGKILL の猶予) に
 * マージンを足した値。infrastructure の定数を application から import すると
 * レイヤー境界を割るので、値の同期はコメントで担保する (bdboard-54be.1)。
 */
export const DEFAULT_CANCELLING_GRACE_MS = 5_000;

export const STUCK_CANCELLING_ERROR =
  'cancelled: process did not exit within the cancel grace period';
