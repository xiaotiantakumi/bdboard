// bdboard-sso1.83 第2段: useChatDraftState.ts から「添付ファイルの取り込み」だけを
// 抜き出したもの(200行制約のための分割、関心は同じくドラフト/添付)。
// conversationAttachments の読み書きは、このファイルが所有する
// conversationAttachmentsRef と updateConversationAttachments に一本化する。
//
// conversationAttachmentsRef を eager sync する理由: 貼り付けが短時間に複数回
// 重なると、後続の paste が前の paste の非同期処理(FileReader)完了を
// conversationAttachmentsRef.current 経由で同期的に読む。useReducer の state は
// レンダーを経ないと更新されないため、dispatch と同時に ref も手動で
// 先行更新し、「直後の同期読み取りが最新のマージ結果を見る」という元実装の
// 保証を維持する(bdboard-c1pw 由来のコメント、元は ChatPanel.tsx 内にあった)。
import { type ChangeEvent, type ClipboardEvent, useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import type { ChatImageMimeType } from '../../api';
import { attachmentsSlice, type ChatDraftAction } from './chatDraftState';
import {
  readFileAsDataUrl,
  validateChatAttachments,
  type ChatAttachment,
} from './attachments';

export interface UseChatAttachmentIngestionParams {
  currentConversationKey: string;
  currentConversationKeyRef: RefObject<string>;
  isSending: boolean;
  dispatch: (action: ChatDraftAction) => void;
  setAttachmentError: (key: string, message: string) => void;
}

export interface UseChatAttachmentIngestionResult {
  conversationAttachmentsRef: RefObject<Record<string, ChatAttachment[]>>;
  updateConversationAttachments: (
    updater: (previous: Record<string, ChatAttachment[]>) => Record<string, ChatAttachment[]>,
  ) => void;
  handleImagePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleImageFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  removeAttachment: (key: string, id: string) => void;
}

export function useChatAttachmentIngestion(
  params: UseChatAttachmentIngestionParams,
  initialAttachments: Record<string, ChatAttachment[]>,
): UseChatAttachmentIngestionResult {
  const { currentConversationKey, currentConversationKeyRef, isSending, dispatch, setAttachmentError } = params;

  const conversationAttachmentsRef = useRef(initialAttachments);
  const attachmentIdRef = useRef(0);

  const dispatchAttachmentsAction = useCallback(
    (action: ChatDraftAction) => {
      const next = attachmentsSlice(conversationAttachmentsRef.current, action);
      conversationAttachmentsRef.current = next;
      dispatch(action);
    },
    [dispatch],
  );

  const updateConversationAttachments = useCallback(
    (updater: (previous: Record<string, ChatAttachment[]>) => Record<string, ChatAttachment[]>) => {
      dispatchAttachmentsAction({ type: 'replace-attachments', updater });
    },
    [dispatchAttachmentsAction],
  );

  const ingestImageFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) {
        return;
      }
      const attachmentKey = currentConversationKey;
      // attachmentKey と imageFiles をキャプチャしたクロージャで .then() 内の再検証を行うため、
      // 連続 paste が3回以上重なると conversationAttachmentsRef.current の読み取りタイミング次第で
      // 上限判定が甘くなりうる。現行の上限4枚では実害が観測されていないが、上限を変えるときはここが表面化しうる。
      const validationError = validateChatAttachments(
        conversationAttachmentsRef.current[attachmentKey] ?? [],
        files,
      );
      if (validationError !== null) {
        setAttachmentError(attachmentKey, validationError);
        return;
      }

      void Promise.all(
        files.map(async (file) => {
          const previewUrl = await readFileAsDataUrl(file);
          attachmentIdRef.current += 1;
          return {
            id: `chat-image-${attachmentIdRef.current}`,
            file,
            mimeType: file.type as ChatImageMimeType,
            previewUrl,
            name: file.name || `貼り付け画像 ${attachmentIdRef.current}`,
            size: file.size,
          } satisfies ChatAttachment;
        }),
      )
        .then((prepared) => {
          // FileReaderの完了前に会話が切り替わった場合、到達不能な旧キーへ
          // 大きなdata URLを残さない。現在の入力欄へ貼り直せる状態を優先する。
          if (currentConversationKeyRef.current !== attachmentKey) return;
          const latestValidationError = validateChatAttachments(
            conversationAttachmentsRef.current[attachmentKey] ?? [],
            files,
          );
          if (latestValidationError !== null) {
            setAttachmentError(attachmentKey, latestValidationError);
            return;
          }
          dispatchAttachmentsAction({ type: 'add-attachments', key: attachmentKey, items: prepared });
        })
        .catch(() => {
          setAttachmentError(attachmentKey, '画像を読み込めませんでした。');
        });
    },
    [currentConversationKey, currentConversationKeyRef, dispatchAttachmentsAction, setAttachmentError],
  );

  const handleImagePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith('image/'),
      );
      // 通常のテキスト paste はブラウザへ委ねる。画像を含む paste のときだけ
      // textarea へのバイナリ由来文字列挿入を止める。
      if (imageFiles.length === 0) {
        return;
      }
      event.preventDefault();
      ingestImageFiles(imageFiles);
    },
    [ingestImageFiles],
  );

  const handleImageFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length === 0) {
        return;
      }
      ingestImageFiles(files);
      event.target.value = '';
    },
    [ingestImageFiles],
  );

  const removeAttachment = useCallback(
    (attachmentKey: string, attachmentId: string) => {
      if (isSending) return;
      dispatchAttachmentsAction({ type: 'remove-attachment', key: attachmentKey, id: attachmentId });
    },
    [isSending, dispatchAttachmentsAction],
  );

  return {
    conversationAttachmentsRef,
    updateConversationAttachments,
    handleImagePaste,
    handleImageFileChange,
    removeAttachment,
  };
}
