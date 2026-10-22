import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { fetchTicketLocalFiles, type LocalFileRefDto } from '../../api/local-files';
import { isLoopbackHostname } from './isLoopbackHostname';
import { LOCAL_FILE_ACCESS_NOTICE, isLocalFileAccessDenied } from './localFileErrorMessage';
import { formatByteSize } from '../TicketAttachments';
import { LocalFileLabel } from './LocalFileLabel';
import { localFileKindLabel } from './localFileKindLabel';
import { LocalFolderThumbnails } from './LocalFolderThumbnails';
import { openLocalFileViewer } from './openLocalFileViewer';
import {
  filterLocalFiles,
  LOCAL_FILE_FILTER_OPTIONS,
  readStoredLocalFileFilter,
  writeStoredLocalFileFilter,
  type LocalFileFilter,
} from './localFileFilter';

export interface TicketLocalFilesSectionProps {
  readonly ticketId: string;
  /** 既定は window.location.hostname。403 の案内を出すかどうか (ローカルでは出さない) だけに使う。テストから差し替えられる。 */
  readonly hostname?: string;
}

/**
 * bdboard-teir: ホスト名では出し分けない。ローカルでも、強いパスワードで認可済みのトンネルセッションでも
 * サーバーが 200 を返し、それ以外は 403 になる (チャット・添付と同じ「まず送ってサーバーの 403 を見る」形)。
 * 403 (トンネルで未認可) のときは、ローカルでない場合だけ 1 行の案内を出す (スマホの利用者に理由を伝える)。ローカルの 403 は異常なので何も出さない。
 */
export function TicketLocalFilesSection({
  ticketId,
  hostname = window.location.hostname,
}: TicketLocalFilesSectionProps) {
  const filesQuery = useQuery({
    queryKey: ['ticket-local-files', ticketId],
    queryFn: () => fetchTicketLocalFiles(ticketId),
    // 403 はポリシーの答えで一時的な失敗ではない。バックオフ付きで再試行すると 1 チケットを開くたびに 4 回送る (useTunnelStatus と同じ形)。
    retry: (failureCount, error) => !isLocalFileAccessDenied(error) && failureCount < 3,
  });
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<LocalFileFilter>(readStoredLocalFileFilter);
  const selectFilter = (next: LocalFileFilter) => {
    setFilter(next);
    writeStoredLocalFileFilter(next);
  };

  if (filesQuery.isError && isLocalFileAccessDenied(filesQuery.error) && !isLoopbackHostname(hostname)) {
    return <p className="local-file-note">{LOCAL_FILE_ACCESS_NOTICE}</p>;
  }
  if (filesQuery.isPending || filesQuery.isError || filesQuery.data === undefined) {
    return null;
  }
  const files = filesQuery.data.files;
  if (files.length === 0) return null;
  const visibleFiles = filterLocalFiles(files, filter);

  return (
    <div className="detail-section">
      <h3>ファイル</h3>
      <div className="local-file-filter" role="group" aria-label="ファイルの種類で絞り込み">
        {LOCAL_FILE_FILTER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="local-file-filter-chip"
            aria-pressed={filter === option.value}
            onClick={() => selectFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {visibleFiles.length === 0 && <p className="local-file-note">この種類のファイルはありません。</p>}
      <ul className="local-files-list">
        {visibleFiles.map((file) => (
          <LocalFileRow
            key={file.path}
            ticketId={ticketId}
            file={file}
            expanded={expandedPath === file.path}
            onToggle={() => setExpandedPath((current) => (current === file.path ? null : file.path))}
          />
        ))}
      </ul>
    </div>
  );
}

function LocalFileRow({
  ticketId,
  file,
  expanded,
  onToggle,
}: {
  readonly ticketId: string;
  readonly file: LocalFileRefDto;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const thumbnailsId = useId();
  if (file.kind === 'directory') {
    return (
      <li>
        <button
          type="button"
          className="local-file-row"
          aria-expanded={expanded}
          aria-controls={expanded ? thumbnailsId : undefined}
          onClick={onToggle}
        >
          <LocalFileLabel kind={file.kind} path={file.path} size={file.size} />
        </button>
        {expanded && (
          <div id={thumbnailsId}>
            <LocalFolderThumbnails
              ticketId={ticketId}
              dirPath={file.path}
              onSelect={(entry) =>
                openLocalFileViewer({
                  ticketId,
                  path: entry.path,
                  kind: entry.kind,
                  size: entry.size,
                })
              }
            />
          </div>
        )}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className="local-file-row"
        aria-label={`${localFileKindLabel(file.kind)}、${file.path}${file.size !== null ? `、${formatByteSize(file.size)}` : ''}（新しいウィンドウで開く）`}
        onClick={() =>
          openLocalFileViewer({
            ticketId,
            path: file.path,
            kind: file.kind,
            size: file.size,
          })
        }
      >
        <LocalFileLabel kind={file.kind} path={file.path} size={file.size} />
      </button>
    </li>
  );
}
