import { describe, expect, it } from 'vitest';
import type { UpdateCheck } from '../../domain/update-check.js';
import { createUpdateCheckRoutes } from './update-check-routes.js';

function requestWith(state: UpdateCheck) {
  const app = createUpdateCheckRoutes({
    updateCheckService: { getUpdateCheck: async () => state },
  });
  return app.request('/api/update-check');
}

describe('createUpdateCheckRoutes', () => {
  it('exposes an available update with the release url', async () => {
    const res = await requestWith({
      kind: 'update-available',
      currentVersion: '1.0.0',
      latestVersion: 'v2.0.0',
      releaseUrl: 'https://github.com/xiaotiantakumi/bdboard/releases/tag/v2.0.0',
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      state: 'update-available',
      currentVersion: '1.0.0',
      latestVersion: 'v2.0.0',
      releaseUrl: 'https://github.com/xiaotiantakumi/bdboard/releases/tag/v2.0.0',
    });
  });

  it.each([['up-to-date'], ['unknown']] as const)(
    'exposes %s without a release url',
    async (kind) => {
      const res = await requestWith({ kind, currentVersion: '1.0.0' });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        state: kind,
        currentVersion: '1.0.0',
      });
    },
  );
});
