/** オフライン動画の公開 API (bdboard-hipq.2)。 */

export type { OfflineVideoEntry, OfflineVideoStore } from './types';

export { offlineVideoKey } from './key';

export {
  OFFLINE_VIDEO_CHUNK_BYTES,
  OFFLINE_VIDEO_MAX_BYTES,
  OFFLINE_VIDEO_QUOTA_MARGIN_BYTES,
  OfflineVideoDownloadError,
  downloadOfflineVideo,
} from './download';
export type {
  DownloadOfflineVideoInput,
  OfflineVideoDownloadFailure,
  OfflineVideoStorageManager,
} from './download';

export {
  OFFLINE_VIDEO_STALE_INCOMPLETE_MS,
  OFFLINE_VIDEO_TTL_MS,
  removeAllOfflineVideos,
  sweepOfflineVideos,
} from './sweep';

export {
  createOpfsOfflineVideoStore,
  getOfflineVideoStore,
  isOfflineVideoSupported,
  probeOfflineVideoSupport,
} from './opfs-store';
