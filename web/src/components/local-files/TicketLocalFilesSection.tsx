import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { fetchTicketLocalFiles, type LocalFileRefDto } from '../../api/local-files';
import { isLoopbackHostname } from '../issue-reports/manualDraftAccess';
import { formatByteSize } from '../TicketAttachments';
import { LocalFileLabel } from './LocalFileLabel';
import { localFileKindLabel } from './localFileKindLabel';
import { LocalFolderThumbnails } from './LocalFolderThumbnails';
import { openLocalFileViewer } from './openLocalFileViewer';

export interface TicketLocalFilesSectionProps {
  readonly ticketId: string;
  /** 既定は window.location.hostname。テストから差し替えられる。 */
  readonly hostname?: string;
}

export function TicketLocalFilesSection({
  ticketId,
  hostname = window.location.hostname,
}: TicketLocalFilesSectionProps) {
  const localAccess = isLoopbackHostname(hostname);
  const filesQuery = useQuery({
    queryKey: ['ticket-local-files', ticketId],
    queryFn: () => fetchTicketLocalFiles(ticketId),
    enabled: localAccess,
  });
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  if (!localAccess || filesQuery.isPending || filesQuery.isError || filesQuery.data === undefined) {
    return null;
  }
  const files = filesQuery.data.files;
  if (files.length === 0) return null;

  return (
    <div className="detail-section">
      <h3>ファイル</h3>
      <ul className="local-files-list">
        {files.map((file) => (
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
