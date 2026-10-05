import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { createManualIssueDraft, type IssueDraftSummaryDto } from '../../api/issue-reports';
import {
  ISSUE_DRAFT_MANUAL_DESCRIPTION_MAX_CHARS,
  ISSUE_DRAFT_TITLE_MAX_CHARS,
  describeIssueDraftManualError,
} from './issueDraftErrors';
import { type ReportProject } from './manualDraftAccess';
import { IssueDraftImagePicker } from './IssueDraftImagePicker';
import { IssueDraftImageFailures } from './IssueDraftImageFailures';
import { useIssueDraftImages } from './useIssueDraftImages';
import { uploadIssueDraftImages, type ImageUploadFailure, type PickedImage } from './issueDraftImageUpload';

export interface IssueDraftManualFormProps {
  /** ボードでちょうど 1 つ選んでいるプロジェクト (reportProjectOf)。あれば、題名の漏れ検出の鍵として一緒に送る。選ぶ欄は無い。 */
  readonly project?: ReportProject | undefined;
  readonly localAccess: boolean;
  /** 作れた (一覧は読み直し済み)。呼び出し側が新しい下書きを選ぶ。 */
  readonly onCreated: (draft: IssueDraftSummaryDto) => void;
  readonly onCancel: () => void;
}

/**
 * 人が手で書く下書き (「新しく報告」、bdboard-4y8q.6.8。POST /api/issue-reports/manual-drafts、docs/ISSUE-REPORTING.md 3節「手書きの下書き」)。
 * 題名 (1 行・256 文字まで) と説明 (8000 文字まで) を書いて送る。説明は手元だけに保存され、公開される本文には入らない (今は「直す」で本文を書く)。
 * 題名・説明は整えずに送る (整えるのはサーバー)。失敗はステータスごとに利用者の言葉で出し (issueDraftErrors.ts)、入力は消さない。
 * 成功したら ['issue-reports'] を読み直してから onCreated を呼ぶ。
 */
export function IssueDraftManualForm({ project, localAccess, onCreated, onCancel }: IssueDraftManualFormProps) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const descriptionId = useId();
  const descriptionHintId = useId();
  const projectHintId = useId();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imageDraft = useIssueDraftImages();
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [imageFailures, setImageFailures] = useState<ImageUploadFailure[] | null>(null);
  const [createdDraft, setCreatedDraft] = useState<IssueDraftSummaryDto | null>(null);

  const retryImages = async (failed: readonly ImageUploadFailure[], snapshot: readonly PickedImage[]) => {
    if (createdDraft === null) return;
    const failedIds = new Set(failed.map((failure) => failure.id));
    const retry = snapshot.filter((image) => failedIds.has(image.id));
    setSending(true);
    const nextFailures = await uploadIssueDraftImages(createdDraft.id, retry, (sent, total) => setProgress({ sent, total }));
    await queryClient.invalidateQueries({ queryKey: ['issue-reports'] });
    setProgress(null);
    setSending(false);
    if (nextFailures.length === 0) onCreated(createdDraft);
    else setImageFailures(nextFailures);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === '') {
      setError('題名を書いてください。');
      return;
    }
    if (description.trim() === '') {
      setError('説明を書いてください。');
      return;
    }
    if (title.length > ISSUE_DRAFT_TITLE_MAX_CHARS || description.length > ISSUE_DRAFT_MANUAL_DESCRIPTION_MAX_CHARS) {
      setError(
        `長すぎて送れません。題名は ${ISSUE_DRAFT_TITLE_MAX_CHARS} 文字、説明は ${ISSUE_DRAFT_MANUAL_DESCRIPTION_MAX_CHARS} 文字までです。`,
      );
      return;
    }
    setSending(true);
    setError(null);
    try {
      const response = await createManualIssueDraft({
        title,
        description,
        ...(project !== undefined ? { project } : {}),
      });
      if (localAccess && imageDraft.images.length > 0) {
        setCreatedDraft(response.draft);
        const failures = await uploadIssueDraftImages(response.draft.id, imageDraft.images, (sent, total) => setProgress({ sent, total }));
        await queryClient.invalidateQueries({ queryKey: ['issue-reports'] });
        setProgress(null);
        if (failures.length > 0) {
          setImageFailures(failures);
          return;
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['issue-reports'] });
      onCreated(response.draft);
    } catch (caught) {
      setError(describeIssueDraftManualError(caught));
    } finally {
      setSending(false);
    }
  };

  if (imageFailures !== null && createdDraft !== null) {
    const snapshot = imageDraft.images;
    return <IssueDraftImageFailures
      failures={imageFailures.map((failure) => ({
        label: `${(snapshot.findIndex((image) => image.id === failure.id) + 1) || '?'} 枚目「${failure.name}」`,
        reason: failure.reason,
      }))}
      sending={sending}
      onRetry={() => void retryImages(imageFailures, snapshot)}
      onOpen={() => onCreated(createdDraft)}
    />;
  }

  return (
    <form
      className="issue-draft-editor"
      aria-label="新しく報告"
      onPaste={localAccess && !sending ? imageDraft.handlePaste : undefined}
      onSubmit={(event) => void handleSubmit(event)}
    >
      <h3 className="issue-draft-section-title">新しく報告</h3>
      <label htmlFor={titleId} className="issue-draft-editor-label">
        題名
        <span className="issue-draft-editor-count">
          {title.length} / {ISSUE_DRAFT_TITLE_MAX_CHARS}
        </span>
      </label>
      {/* 押した「新しく報告」から書く欄へ移す (書く画面は一覧の後ろにあり、狭い幅では押したボタンごと一覧が隠れてフォーカスが body へ落ちる)。 */}
      <input
        id={titleId}
        className="issue-draft-editor-title"
        type="text"
        value={title}
        autoFocus
        aria-describedby={project !== undefined ? projectHintId : undefined}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label htmlFor={descriptionId} className="issue-draft-editor-label">
        説明
        <span className="issue-draft-editor-count">
          {description.length} / {ISSUE_DRAFT_MANUAL_DESCRIPTION_MAX_CHARS}
        </span>
      </label>
      <textarea
        id={descriptionId}
        className="issue-draft-editor-body"
        rows={10}
        value={description}
        aria-describedby={descriptionHintId}
        onChange={(event) => setDescription(event.target.value)}
      />
      <p className="issue-draft-editor-hint" id={descriptionHintId}>
        説明は手元に保存するだけで、公開される本文にはまだ入りません (投稿の前に置き換えを通してから公開本文に入れる仕組みは、今後入ります)。公開する本文は、下書きを作ったあとに「直す」で書けます。
      </p>
      {project !== undefined && (
        <p className="issue-draft-editor-hint" id={projectHintId}>
          対象プロジェクト: {project.name}。題名にこのプロジェクトの名前やパスを書くと、置き換え漏れの疑いが付きます。
        </p>
      )}
      {localAccess && <IssueDraftImagePicker images={imageDraft.images} problems={imageDraft.problems} disabled={sending} onAddFiles={imageDraft.addFiles} onRemove={imageDraft.remove} />}
      {progress !== null && <p role="status">画像を送っています ({progress.sent} / {progress.total})</p>}
      {error !== null && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="issue-draft-editor-actions">
        <button type="submit" className="btn" disabled={sending}>
          {sending ? '送信中…' : '送る'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={sending}>
          やめる
        </button>
      </div>
    </form>
  );
}
