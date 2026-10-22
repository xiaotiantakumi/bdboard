/**
 * Renders ticket text as Markdown without dangerouslySetInnerHTML.
 *
 * XSS protection relies on react-markdown building a React element tree from the
 * Markdown AST and not enabling rehype-raw (raw HTML such as `<script>` stays
 * escaped text). Do not add rehype-raw or similar plugins without revisiting
 * sanitization.
 */
import { useMemo } from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BEAD_ID_URL_PREFIX,
  remarkBeadIdLinks,
} from '../markdown/remarkBeadIdLinks';
import {
  LOCAL_FILE_URL_PREFIX,
  localFilePathFromUrl,
  remarkLocalFileLinks,
} from '../markdown/remarkLocalFileLinks';
import { openLocalFileViewer } from './local-files/openLocalFileViewer';
import { useTicketLocalFileLinks } from './local-files/TicketLocalFileLinks';

export interface MarkdownContentProps {
  text: string;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  className?: string;
}

function beadIdFromHref(href: string | undefined): string | undefined {
  if (href === undefined || !href.startsWith(BEAD_ID_URL_PREFIX)) {
    return undefined;
  }
  return href.slice(BEAD_ID_URL_PREFIX.length);
}

export function MarkdownContent({
  text,
  isTicketOnBoard,
  onOpenTicket,
  className,
}: MarkdownContentProps) {
  const localFiles = useTicketLocalFileLinks();
  const localFilePaths = useMemo(
    () => (localFiles?.files ?? []).map((file) => file.path),
    [localFiles],
  );
  const components: Components = {
    a: ({ href, children, ...props }) => {
      const localPath = localFilePathFromUrl(href);
      if (localPath !== undefined && localFiles !== null) {
        const file = localFiles.files.find((candidate) => candidate.path === localPath);
        if (file !== undefined) {
          // ファイル一覧の行と同じ: 新しいタブのビューアで開く (フォルダもビューアがサムネイル一覧を出す)。
          return (
            <button
              type="button"
              className="markdown-local-file-link"
              title={`${file.path}（新しいウィンドウで開く）`}
              onClick={() =>
                openLocalFileViewer({
                  ticketId: localFiles.ticketId,
                  path: file.path,
                  kind: file.kind,
                  size: file.size,
                })
              }
            >
              {children}
            </button>
          );
        }
      }
      const beadId = beadIdFromHref(href);
      if (beadId !== undefined) {
        return (
          <button
            type="button"
            className="ticket-id-link markdown-bead-link"
            onClick={() => onOpenTicket(beadId)}
          >
            {children}
          </button>
        );
      }

      return (
        <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
          {children}
        </a>
      );
    },
  };

  const wrapperClassName = ['markdown-body', className].filter(Boolean).join(' ');

  return (
    <div className={wrapperClassName}>
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          [remarkBeadIdLinks, isTicketOnBoard],
          [remarkLocalFileLinks, localFilePaths],
        ]}
        urlTransform={(url) => {
          if (url.startsWith(BEAD_ID_URL_PREFIX) || url.startsWith(LOCAL_FILE_URL_PREFIX)) {
            return url;
          }
          return defaultUrlTransform(url);
        }}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
