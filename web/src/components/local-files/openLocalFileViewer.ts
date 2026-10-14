import type { LocalFileKind } from '../../api/local-files';
import { buildLocalFileViewerUrl } from '../../localFileViewerRoute';

export function openLocalFileViewer(input: {
  readonly ticketId: string;
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size: number | null;
}): void {
  window.open(
    buildLocalFileViewerUrl({
      ticketId: input.ticketId,
      path: input.path,
      kind: input.kind,
      size: input.size,
    }),
    '_blank',
    'noopener',
  );
}
