import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { createIssueReportRoutes } from '../interface/http/issue-report-routes.js';

/**
 * bdboard-mqoa: ファイル保存 (本番の保存層) と下書きの API をつないだときの ETag。interface 層のテストは保存層を import できない
 * (依存の向き) ので、組み立てを担う bootstrap に置く。メモリ上の保存層のテストは interface/http/issue-report-routes-etag.test.ts。
 */

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const LOCAL_HOST = 'localhost:8787';
const DRAFTS = '/api/issue-reports/drafts';
const STRONG_ETAG = /^"[0-9a-f]{32}"$/;

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { 'content-type': 'application/json', host: LOCAL_HOST, ...headers }, body: JSON.stringify(body) };
}

describe('the ETag with the file storage, which reads the keys back in the schema order', () => {
  it('gives the draft just edited in memory the same ETag as the same draft read back from disk', async () => {
    // 編集した直後のメモリ上の下書きは suspectedLeaks が末尾にあり、読み直した下書きは zod のスキーマの順で並ぶ。
    // キーの順で ETag が変わると、保存の応答の ETag で次の PATCH を送ったときに 412 になる。
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-mqoa-'));
    try {
      let seq = 0;
      const service = createIssueDraftService({
        storage: createFsIssueDraftStorage(dir, { warn: () => undefined }),
        now: () => new Date('2026-10-04T12:00:00.000Z'),
        newId: () => {
          seq += 1;
          return `${1758812345000 + seq}-${seq.toString(16).padStart(16, '0')}`;
        },
        retention: { warn: () => undefined },
      });
      const app = createIssueReportRoutes({ service, latestHarnessVersion: async () => '0.50.0' });
      const received = await app.request(
        DRAFTS,
        json('POST', { kind: 'A', catalogSlug: 'slug-a', envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' } }),
        LOCAL_ENV,
      );
      expect([200, 201]).toContain(received.status);
      const id = ((await received.json()) as { draft: { id: string } }).draft.id;
      const edited = await app.request(
        `${DRAFTS}/${id}`,
        json('PATCH', { title: 'Edited', body: 'cwd /Users/example-user/work' }),
        LOCAL_ENV,
      );
      expect(edited.status).toBe(200);
      const etag = edited.headers.get('ETag');
      expect(etag).toMatch(STRONG_ETAG);
      const read = await app.request(`${DRAFTS}/${id}`, { headers: { host: LOCAL_HOST } }, LOCAL_ENV);
      expect(read.status).toBe(200);
      expect(read.headers.get('ETag')).toBe(etag);
      const again = await app.request(
        `${DRAFTS}/${id}`,
        json('PATCH', { title: 'Again' }, { 'if-match': etag as string }),
        LOCAL_ENV,
      );
      expect(again.status).toBe(200);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
