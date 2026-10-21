import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { fetchTicketLocalFiles, type LocalFileKind, type LocalFileListEntryDto } from '../../api/local-files';
import { buildLocalFileViewerUrl, localFileNameOf, type LocalFileViewerRoute } from '../../localFileViewerRoute';
import { formatByteSize } from '../TicketAttachments';
import { LOCAL_FILE_ACCESS_HELP, isLocalFileAccessDenied } from './localFileErrorMessage';
import { LocalFolderThumbnails } from './LocalFolderThumbnails';
import { LocalImageViewer } from './LocalImageViewer';
import { LocalJsonViewer } from './LocalJsonViewer';
import { LocalMarkdownViewer } from './LocalMarkdownViewer';
import { LocalMediaViewer } from './LocalMediaViewer';
import { LocalTextViewer } from './LocalTextViewer';

export interface LocalFileViewerPageProps {
  readonly route: LocalFileViewerRoute;
}

interface ShownFile {
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size?: number | null;
}

/**
 * bdboard-teir: ホスト名では止めない。ローカル直と、強いパスワードで認可済みのトンネルセッション
 * (チャット・添付と同じ資格) をサーバーのガードが通す。ガードが 403 を返したときだけ案内を出す。
 * 画像・動画は <img>/<video> がそのまま取りに行き失敗の理由が見えないので、ガードが掛かる一覧を先に 1 回引いて判定する。
 */
export function LocalFileViewerPage({ route }: LocalFileViewerPageProps) {
  const accessProbe = useQuery({
    queryKey: ['ticket-local-files', route.ticketId],
    queryFn: () => fetchTicketLocalFiles(route.ticketId),
  });
  const denied = accessProbe.isError && isLocalFileAccessDenied(accessProbe.error);
  const [shown, setShown] = useState<ShownFile>({
    path: route.path,
    kind: route.kind,
    size: route.size,
  });

  useEffect(() => {
    if (denied) {
      document.title = 'bdboard';
      return;
    }
    document.title = `${localFileNameOf(shown.path)} - bdboard`;
  }, [denied, shown.path]);

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

  if (denied) {
    return (
      <p className="local-file-note" role="alert">
        {LOCAL_FILE_ACCESS_HELP}
      </p>
    );
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
