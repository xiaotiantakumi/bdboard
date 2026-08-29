import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUnattendedRefresh } from './run-unattended-refresh.js';

// bdboard-66sp: watcher/interval 起点の生存と /api/refresh 経由の failure 伝播は
// 両方とも壊れやすいので、1ファイルで両性質を固定する (片方だけ直すと退行に気付けない)。

const cacheListProjectsIoError = new Error('SQLITE_IOERR: disk I/O error');

function failingRefresh(): Promise<void> {
  return Promise.reject(cacheListProjectsIoError);
}

describe('runUnattendedRefresh (bdboard-66sp)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('性質A: watcher / interval 起点は reject せず生存する', () => {
    it('refresh が throw しても resolve し、console.error に1回ログする', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        runUnattendedRefresh({ refresh: failingRefresh }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        `Unattended refresh error: ${cacheListProjectsIoError.message}`,
      );
    });

    it('onError を渡す場合はそれが呼ばれ、console.error は使わない', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onError = vi.fn();

      await expect(
        runUnattendedRefresh({ refresh: failingRefresh, onError }),
      ).resolves.toBeUndefined();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(cacheListProjectsIoError);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('性質B: /api/refresh 経由の failure 伝播は壊れていない', () => {
    it('runUnattendedRefresh を経由せず refresh を直接 await すると reject が伝播する', async () => {
      // /api/refresh ルートは deps.refresh() を await + try/catch する。
      // wrapper を通さない経路 (= ルートハンドラの await deps.refresh()) は
      // 今までどおり reject する前提が壊れていないことをここで固定する。
      await expect(failingRefresh()).rejects.toThrow(cacheListProjectsIoError);
    });
  });
});
