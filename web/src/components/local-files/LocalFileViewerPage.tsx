import { useCallback, useEffect, useState } from 'react';
import type { LocalFileKind, LocalFileListEntryDto } from '../../api/local-files';
import { buildLocalFileViewerUrl, localFileNameOf, type LocalFileViewerRoute } from '../../localFileViewerRoute';
import { formatByteSize } from '../TicketAttachments';
import { isLoopbackHostname } from '../issue-reports/manualDraftAccess';
import { LocalFolderThumbnails } from './LocalFolderThumbnails';
import { LocalImageViewer } from './LocalImageViewer';
import { LocalJsonViewer } from './LocalJsonViewer';
import { LocalMarkdownViewer } from './LocalMarkdownViewer';
import { LocalMediaViewer } from './LocalMediaViewer';
import { LocalTextViewer } from './LocalTextViewer';

export interface LocalFileViewerPageProps {
  readonly route: LocalFileViewerRoute;
  /** 既定は window.location.hostname。テストから差し替えられる。 */
  readonly hostname?: string;
}

interface ShownFile {
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size?: number | null;
}

export function LocalFileViewerPage({
  route,
  hostname = window.location.hostname,
}: LocalFileViewerPageProps) {
  const local = isLoopbackHostname(hostname);
  const [shown, setShown] = useState<ShownFile>({
    path: route.path,
    kind: route.kind,
    size: route.size,
  });

  useEffect(() => {
    if (!local) {
      document.title = 'bdboard';
      return;
    }
    document.title = `${localFileNameOf(shown.path)} - bdboard`;
  }, [local, shown.path]);

  const show = useCallback((next: ShownFile) => {
    setShown(next);
    window.history.replaceState(
      null,
      '',
      buildLocalFileViewerUrl({
        ticketId: route.ticketId,
        path: next.path,
        kind: next.kind,
        size: next.size,
      }),
    );
  }, [route.ticketId]);

  const showEntry = useCallback(
    (entry: LocalFileListEntryDto) => show({ path: entry.path, kind: entry.kind, size: entry.size }),
    [show],
  );

  if (!local) {
    return <p className="local-file-note">このビューアはローカルで開いたときだけ使えます。</p>;
  }

  return (
    <div className="local-file-viewer-page">
      <header className="local-file-viewer-header">
        <span className="local-file-viewer-path">{shown.path}</span>
        {typeof shown.size === 'number' && (
          <span className="local-file-viewer-size">{formatByteSize(shown.size)}</span>
        )}
      </header>
      <div className="local-file-viewer-body">
        {shown.kind === 'image' && (
          <LocalImageViewer
            key={shown.path}
            ticketId={route.ticketId}
            path={shown.path}
            onNavigate={showEntry}
          />
        )}
        {(shown.kind === 'video' || shown.kind === 'audio') && (
          <LocalMediaViewer key={shown.path} ticketId={route.ticketId} path={shown.path} kind={shown.kind} />
        )}
        {shown.kind === 'directory' && (
          <LocalFolderThumbnails
            key={shown.path}
            ticketId={route.ticketId}
            dirPath={shown.path}
            onSelect={showEntry}
          />
        )}
        {shown.kind === 'markdown' && (
          <LocalMarkdownViewer key={shown.path} ticketId={route.ticketId} path={shown.path} />
        )}
        {shown.kind === 'json' && (
          <LocalJsonViewer key={shown.path} ticketId={route.ticketId} path={shown.path} />
        )}
        {shown.kind === 'text' && (
          <LocalTextViewer key={shown.path} ticketId={route.ticketId} path={shown.path} />
        )}
      </div>
    </div>
  );
}
