import {
  refreshProjects,
  type RefreshProjectsDeps,
  type RefreshResult,
} from './refresh-projects.js';

/**
 * 起動時の初期リフレッシュ。
 *
 * force を付けない = キャッシュのフィンガープリントを尊重する。以前は composition root が
 * force: true で呼んでおり、warm cache でも全プロジェクトを bd に問い合わせ直していた。
 * 12 プロジェクトで time-to-health が 7 秒超(計測環境によっては 29 秒)かかり、その間ボードが
 * 一切見えなかった (bdboard-4rw)。
 *
 * 鮮度はフィンガープリンタ・chokidar watcher・定期の強制リフレッシュで担保されるので、
 * 起動時に強制する必要はない。ここに force を足し戻さないこと。
 */
export function runInitialRefresh(
  deps: RefreshProjectsDeps,
): Promise<RefreshResult> {
  return refreshProjects(deps);
}
