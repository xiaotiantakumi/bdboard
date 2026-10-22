import { useState } from 'react';
import { localFileRawUrl } from '../../api/local-files';
import { OFFLINE_VIDEO_MAX_BYTES } from '../../lib/offline-video';
import { formatByteSize } from '../TicketAttachments';
import { useOfflineVideo } from './useOfflineVideo';

export interface LocalMediaViewerProps {
  readonly ticketId: string;
  readonly path: string;
  readonly kind: 'video' | 'audio';
  readonly size?: number | null;
  /** 端末保存の有無が変わったとき (保存完了・端末から削除)。 */
  readonly onOfflineChange?: () => void;
  /**
   * サーバーに読めない (403) とき。端末に保存済みの動画だけを流し、無ければ何も出さない。
   * 保存・削除の操作も出さない。
   */
  readonly offlineOnly?: boolean;
}

export function LocalMediaViewer({
  ticketId,
  path,
  kind,
  size = null,
  onOfflineChange,
  offlineOnly = false,
}: LocalMediaViewerProps) {
  const [failed, setFailed] = useState(false);
  const offline = useOfflineVideo(ticketId, path, kind === 'video', size, onOfflineChange);
  const src = localFileRawUrl(ticketId, path);
  const message = kind === 'video' ? '動画を再生できませんでした。' : '音声を再生できませんでした。';
  const knownSize = positiveSize(offline.entry?.size) ?? positiveSize(size);
  const tooLargeToSave = knownSize !== null && knownSize > OFFLINE_VIDEO_MAX_BYTES;
  if (offlineOnly && (kind !== 'video' || offline.blobUrl === null)) return null;

  return (
    <div>
      {kind === 'video' ? (
        offline.blobUrl !== null ? (
          // key を分け、ネットワーク再生の要素を使い回さず作り直す (src 属性から source への切替)。
          <video
            key="offline"
            className="local-file-viewer-media"
            controls
            preload="metadata"
            onPlay={offline.markPlayed}
            onError={() => setFailed(true)}
          >
            {/* WebKit では blob URL を video の src 属性に付けると再生できないことがあるため source を使う。 */}
            <source src={offline.blobUrl} type="video/mp4" />
          </video>
        ) : (
          <video
            key="network"
            className="local-file-viewer-media"
            controls
            preload="metadata"
            src={src}
            onError={() => setFailed(true)}
          />
        )
      ) : (
        <audio
          className="local-file-viewer-media"
          controls
          preload="metadata"
          src={src}
          onError={() => setFailed(true)}
        />
      )}
      {kind === 'video' && !offlineOnly && offline.supported && !offline.saveBlocked && (
        <div className="local-file-offline-actions">
          {offline.progress !== null ? (
            <span className="local-file-viewer-position">保存中 {offline.progress}%</span>
          ) : offline.entry?.complete === true ? (
            <>
              <span className="local-file-viewer-position">保存済み（端末から再生）</span>
              <button type="button" onClick={offline.remove}>
                端末から削除
              </button>
            </>
          ) : tooLargeToSave ? (
            <p className="local-file-note">1 GiB を超える動画は端末に保存できません</p>
          ) : (
            <button type="button" onClick={offline.save}>
              {knownSize !== null ? `端末に保存（${formatByteSize(knownSize)}）` : '端末に保存'}
            </button>
          )}
        </div>
      )}
      {failed && (
        <p className="local-file-note" role="alert">
          {message}
        </p>
      )}
      {kind === 'video' && offline.error !== null && (
        <p className="local-file-note" role="alert">
          {offline.error}
        </p>
      )}
    </div>
  );
}

function positiveSize(size: number | null | undefined): number | null {
  return typeof size === 'number' && size > 0 ? size : null;
}
