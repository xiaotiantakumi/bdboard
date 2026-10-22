import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { fetchTicketLocalFiles, type LocalFileRefDto } from '../../api/local-files';
import { isLocalFileAccessDenied } from './localFileErrorMessage';

/**
 * 本文 (説明・経緯・コメント) の中のパスをリンクにするための、そのチケットの解決済みファイル一覧 (bdboard-32vv)。
 * ファイルセクションと同じ query キーなので、取得は共有される。取れなかったとき (403 含む) は空 = リンクにしない。
 */
export interface TicketLocalFileLinks {
  readonly ticketId: string;
  readonly files: readonly LocalFileRefDto[];
}

const TicketLocalFileLinksContext = createContext<TicketLocalFileLinks | null>(null);

export function useTicketLocalFileLinks(): TicketLocalFileLinks | null {
  return useContext(TicketLocalFileLinksContext);
}

export function TicketLocalFileLinksProvider({
  ticketId,
  children,
}: {
  readonly ticketId: string;
  readonly children: ReactNode;
}) {
  const filesQuery = useQuery({
    queryKey: ['ticket-local-files', ticketId],
    queryFn: () => fetchTicketLocalFiles(ticketId),
    retry: (failureCount, error) => !isLocalFileAccessDenied(error) && failureCount < 3,
  });
  const files = filesQuery.data?.files;
  const value = useMemo<TicketLocalFileLinks>(
    () => ({ ticketId, files: files ?? [] }),
    [ticketId, files],
  );
  return (
    <TicketLocalFileLinksContext.Provider value={value}>
      {children}
    </TicketLocalFileLinksContext.Provider>
  );
}
