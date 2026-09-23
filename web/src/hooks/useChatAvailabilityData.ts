import { useQuery } from '@tanstack/react-query';
import { fetchChatAvailability } from '../api';

/**
 * bdboard-62p4 PR-3: App.tsx の `chat-availability` クエリと、そこから導く
 * chatAvailable の判定を集約した。queryKey/queryFn/retry と判定式は元の
 * App.tsx (旧 L299-303, L347-349) から1文字も変えていない。
 */
export function useChatAvailabilityData() {
  const chatAvailabilityQuery = useQuery({
    queryKey: ['chat-availability'],
    queryFn: fetchChatAvailability,
    retry: false,
  });

  // 'unknown'(認証未確認) でもチャット自体は開かせる。開けなくすると
  // 「判定できていないだけ」を「使えない」と扱う別種の嘘になる。
  const chatAvailable =
    chatAvailabilityQuery.data !== undefined &&
    chatAvailabilityQuery.data.availability !== 'unavailable';

  return { chatAvailabilityQuery, chatAvailable };
}
