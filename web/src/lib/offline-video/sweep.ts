import type { OfflineVideoEntry, OfflineVideoStore } from './types';

const HOUR_MS = 60 * 60 * 1000;

/** complete な動画を残す上限。最終活動から 3 日。 */
export const OFFLINE_VIDEO_TTL_MS = 3 * 24 * HOUR_MS;

/** 未完了 (complete=false) を残す上限。最終活動から 24 時間。 */
export const OFFLINE_VIDEO_STALE_INCOMPLETE_MS = 24 * HOUR_MS;

/**
 * 端末内のオフライン動画を期限で捨てる (bdboard-hipq.2)。
 * 最終活動は savedAt と lastPlayedAt の新しい方。
 * complete は 3 日、未完了は 24 時間を超えたらファイルと台帳行を消す。
 * listFiles にあって台帳に無いキーは孤児として消す。台帳は減ったときだけ書き戻す。
 */
export async function sweepOfflineVideos(
  now: number,
  store: OfflineVideoStore,
): Promise<{ removed: string[] }> {
  const manifest = await store.readManifest();
  const removed: string[] = [];

  for (const entry of manifest) {
    if (!isExpired(entry, now)) continue;
    await store.removeFile(entry.key);
    removed.push(entry.key);
  }

  if (removed.length > 0) {
    // 掃除中に保存が足した行を古い一覧で上書きしないよう、読み直して消した行だけ除く。
    const removedKeys = new Set(removed);
    const latest = await store.readManifest();
    await store.writeManifest(latest.filter((entry) => !removedKeys.has(entry.key)));
  }

  // 孤児判定も読み直した台帳で行う。保存はファイルより先に台帳行を書く。
  const manifestKeys = new Set((await store.readManifest()).map((entry) => entry.key));
  for (const key of await store.listFiles()) {
    if (manifestKeys.has(key)) continue;
    await store.removeFile(key);
    removed.push(key);
  }

  return { removed };
}

/** 台帳の全キーと listFiles の全キーを消し、台帳を空にする。 */
export async function removeAllOfflineVideos(store: OfflineVideoStore): Promise<void> {
  const keys = new Set<string>();
  for (const entry of await store.readManifest()) keys.add(entry.key);
  for (const key of await store.listFiles()) keys.add(key);
  for (const key of keys) await store.removeFile(key);
  await store.writeManifest([]);
}

function isExpired(entry: OfflineVideoEntry, now: number): boolean {
  const idle = now - Math.max(entry.savedAt, entry.lastPlayedAt);
  const limit = entry.complete ? OFFLINE_VIDEO_TTL_MS : OFFLINE_VIDEO_STALE_INCOMPLETE_MS;
  return idle > limit;
}
