/**
 * Renders ticket text as Markdown without dangerouslySetInnerHTML.
 *
 * XSS protection relies on react-markdown building a React element tree from the
 * Markdown AST and not enabling rehype-raw (raw HTML such as `<script>` stays
 * escaped text). Do not add rehype-raw or similar plugins without revisiting
 * sanitization.
 */
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BEAD_ID_URL_PREFIX,
  remarkBeadIdLinks,
} from '../markdown/remarkBeadIdLinks';

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
  const components: Components = {
    a: ({ href, children, ...props }) => {
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
        remarkPlugins={[remarkGfm, [remarkBeadIdLinks, isTicketOnBoard]]}
        urlTransform={(url) => {
          if (url.startsWith(BEAD_ID_URL_PREFIX)) {
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
