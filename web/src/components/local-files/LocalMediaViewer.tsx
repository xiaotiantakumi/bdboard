import { useState } from 'react';
import { localFileRawUrl } from '../../api/local-files';

export interface LocalMediaViewerProps {
  readonly ticketId: string;
  readonly path: string;
  readonly kind: 'video' | 'audio';
}

export function LocalMediaViewer({ ticketId, path, kind }: LocalMediaViewerProps) {
  const [failed, setFailed] = useState(false);
  const src = localFileRawUrl(ticketId, path);
  const message = kind === 'video' ? '動画を再生できませんでした。' : '音声を再生できませんでした。';

  return (
    <div>
      {kind === 'video' ? (
        <video
          className="local-file-viewer-media"
          controls
          preload="metadata"
          src={src}
          onError={() => setFailed(true)}
        />
      ) : (
        <audio
          className="local-file-viewer-media"
          controls
          preload="metadata"
          src={src}
          onError={() => setFailed(true)}
        />
      )}
      {failed && (
        <p className="local-file-note" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
