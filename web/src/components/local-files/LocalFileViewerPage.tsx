import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLocalFileList, type LocalFileKind, type LocalFileListEntryDto } from '../../api/local-files';
import { buildLocalFileViewerUrl, localFileNameOf, type LocalFileViewerRoute } from '../../localFileViewerRoute';
import {
  getOfflineVideoStore,
  probeOfflineVideoSupport,
  removeAllOfflineVideos,
} from '../../lib/offline-video';
import { useOfflineVideoSweep } from '../../lib/offline-video/useOfflineVideoSweep';
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
 * 画像・動画は <img>/<video> がそのまま取りに行き失敗の理由が見えないので、ガードが掛かる安い呼び出し (/list。bd を呼ばない) を先に 1 回引いて判定し、
 * 結果が出るまでビューアを載せない (403 の前に壊れた <img>/<video> を見せない)。403 以外の失敗はビューア側の表示に任せる。
 */
export function LocalFileViewerPage({ route }: LocalFileViewerPageProps) {
  useOfflineVideoSweep();
  const [offlineEpoch, setOfflineEpoch] = useState(0);
  // 保存・削除のたびに「全て削除」ボタンの表示を読み直す (プレーヤーの key には使わない)。
  const [offlineChanges, setOfflineChanges] = useState(0);
  const onOfflineChange = useCallback(() => setOfflineChanges((count) => count + 1), []);
  const accessProbe = useQuery({
    queryKey: ['ticket-local-files-access-probe', route.ticketId],
    queryFn: async () => {
      try {
        await fetchLocalFileList(route.ticketId, '.');
      } catch (error) {
        // ガード通過後の 400 (パス不正) などはここでは関係ない。403 だけを失敗として扱う。
        if (isLocalFileAccessDenied(error)) throw error;
      }
      return true;
    },
    retry: false,
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
    // セッションが切れても、端末に保存済みの動画は再生できる (保存の操作は出さない)。
    return (
      <>
        <p className="local-file-note" role="alert">
          {LOCAL_FILE_ACCESS_HELP}
        </p>
        {shown.kind === 'video' && (
          <LocalMediaViewer ticketId={route.ticketId} path={shown.path} kind="video" offlineOnly />
        )}
      </>
    );
  }

  if (accessProbe.isPending) {
    return null;
  }

  return (
    <div className="local-file-viewer-page">
      <header className="local-file-viewer-header">
        <span className="local-file-viewer-path">{shown.path}</span>
        {typeof shown.size === 'number' && (
          <span className="local-file-viewer-size">{formatByteSize(shown.size)}</span>
        )}
        <RemoveAllOfflineVideosButton
          changes={offlineChanges}
          onRemoved={() => setOfflineEpoch((epoch) => epoch + 1)}
        />
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
          <LocalMediaViewer
            key={`${shown.path}:${offlineEpoch}`}
            ticketId={route.ticketId}
            path={shown.path}
            kind={shown.kind}
            size={typeof shown.size === 'number' ? shown.size : null}
            onOfflineChange={onOfflineChange}
          />
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

function RemoveAllOfflineVideosButton({
  changes,
  onRemoved,
}: {
  readonly changes: number;
  readonly onRemoved: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const removing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!(await probeOfflineVideoSupport())) return;
        const manifest = await getOfflineVideoStore().readManifest();
        if (!cancelled) setVisible(manifest.length > 0);
      } catch {
        // 台帳が読めなければボタンは出さない。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [changes]);

  const onClick = () => {
    if (removing.current) return;
    if (!window.confirm('端末に保存した動画をすべて削除しますか？')) return;
    removing.current = true;
    void (async () => {
      try {
        await removeAllOfflineVideos(getOfflineVideoStore());
        setVisible(false);
        onRemoved();
      } catch {
        // 消せなければボタンを残し、もう一度押せるようにする。
      } finally {
        removing.current = false;
      }
    })();
  };

  if (!visible) return null;
  return (
    <button type="button" className="local-file-viewer-remove-all" onClick={onClick}>
      保存した動画を全て削除
    </button>
  );
}
