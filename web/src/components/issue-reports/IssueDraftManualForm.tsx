import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { createManualIssueDraft, type IssueDraftSummaryDto } from '../../api/issue-reports';
import { IssueDraftImageFailures } from './IssueDraftImageFailures';
import { IssueDraftImagePicker } from './IssueDraftImagePicker';
import {
  ISSUE_DRAFT_MANUAL_DESCRIPTION_MAX_CHARS,
  ISSUE_DRAFT_TITLE_MAX_CHARS,
  describeIssueDraftManualError,
} from './issueDraftErrors';
import { findImagesAlreadyStored } from './issueDraftImageResend';
import { uploadIssueDraftImages, type ImageUploadFailure, type PickedImage } from './issueDraftImageUpload';
import { useMountedRef } from '../../hooks/useMountedRef';
import { type ReportProject } from './manualDraftAccess';
import { useIssueDraftImages } from './useIssueDraftImages';

export interface IssueDraftManualFormProps {
  /** ボードでちょうど 1 つ選んでいるプロジェクト (reportProjectOf)。あれば、題名の漏れ検出の鍵として一緒に送る。選ぶ欄は無い。 */
  readonly project?: ReportProject | undefined;
  /**
   * ローカルで開いているか (パネルが isLoopbackHostname で決めた値)。false (トンネル経由など) のときは、画像の欄・注記・貼り付けとドロップの処理を出さない。
   * 画像の受け口はトンネルでは常に 403 なので、入力を見せない (正はサーバーの 403)。
   */
  readonly localAccess: boolean;
  /** 作れた (一覧は読み直し済み)。呼び出し側が新しい下書きを選ぶ。画像が付かなかったときは、利用者が「下書きを開く」を押したときに呼ぶ。 */
  readonly onCreated: (draft: IssueDraftSummaryDto) => void;
  readonly onCancel: () => void;
  /**
   * 失敗の画面 (画像が付かなかった結果) を出しているかが変わったときに呼ぶ (閉じるときは false)。パネルが、この画面を出している間に
   * 「新しく報告」を押されたら書く画面を作り直す (key を替える) ために使う。書きかけの画面は、押されても作り直さない (入力を消さない)。bdboard-8zwi。
   */
  readonly onResultShownChange?: (shown: boolean) => void;
}

/** 下書きは作れたが、画像が付かなかったもの。ここにある間は、書く画面の代わりに失敗の画面を出す。 */
interface PartialOutcome {
  readonly draft: IssueDraftSummaryDto;
  readonly failures: readonly ImageUploadFailure[];
  /** サーバーに付いたと分かっている画像の、サーバー側の file 名。送り直しで同じ画像を二重に付けない目印 (issueDraftImageResend.ts)。 */
  readonly storedFileNames: ReadonlySet<string>;
}

/**
 * 人が手で書く下書き (「新しく報告」、bdboard-4y8q.6.8。POST /api/issue-reports/manual-drafts、docs/ISSUE-REPORTING.md 3節「手書きの下書き」)。
 * 題名 (1 行・256 文字まで) と説明 (8000 文字まで) を書いて送る。説明は手元だけに保存され、公開される本文には入らない (今は「直す」で本文を書く)。
 * 題名・説明は整えずに送る (整えるのはサーバー)。失敗はステータスごとに利用者の言葉で出し (issueDraftErrors.ts)、入力は消さない。
 *
 * 画像 (bdboard-4y8q.6.9、同 3節「画像を付ける」): ローカルで開いているときだけ、貼り付け・ドロップ・ファイルの選択で付けられる。
 * 送る順序は、下書きの作成 → 画像を 1 枚ずつ → ['issue-reports'] の読み直し → 全部付いていれば onCreated。
 * 下書きは作れた時点で成功しているので、画像の失敗で消さず・作り直さない: 失敗の画面 (IssueDraftImageFailures) に付かなかった画像を出し、
 * その画像だけ送り直すか、下書きを開く。成功したら ['issue-reports'] を読み直してから onCreated を呼ぶ。
 */
export function IssueDraftManualForm({
  project,
  localAccess,
  onCreated,
  onCancel,
  onResultShownChange,
}: IssueDraftManualFormProps) {
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
  const [partial, setPartial] = useState<PartialOutcome | null>(null);
  const mounted = useMountedRef();

  const resultShown = partial !== null;
  useEffect(() => {
    onResultShownChange?.(resultShown);
    return () => onResultShownChange?.(false);
  }, [resultShown, onResultShownChange]);

  // 失敗の一覧に出す名前。同じ名前の画像を見分けるため、送る前の一覧での位置を付ける。
  const failureItems = useMemo(
    () =>
      (partial?.failures ?? []).map((failure) => ({
        label: `${imageDraft.images.findIndex((image) => image.id === failure.id) + 1} 枚目「${failure.name}」`,
        reason: failure.reason,
      })),
    [partial, imageDraft.images],
  );

  /**
   * 画像を送り、一覧を読み直して、全部付いたら下書きを選ばせる。付かなかった分があれば失敗の画面を (新しく) 出す。
   * 送る画像が無ければ (画像なし・トンネル) 送信も進み具合も出さず、読み直しと onCreated だけ。
   * `knownFileNames` は、前の回までに付いたと分かっている画像のサーバー側の file 名 (送り直しのとき)。
   */
  const finishCreated = async (
    draft: IssueDraftSummaryDto,
    targets: readonly PickedImage[],
    knownFileNames: ReadonlySet<string> = new Set(),
  ) => {
    let failures: readonly ImageUploadFailure[] = [];
    const storedFileNames = new Set(knownFileNames);
    if (targets.length > 0) {
      failures = await uploadIssueDraftImages(
        draft.id,
        targets,
        (sent, total) => setProgress({ sent, total }),
        (_image, fileName) => storedFileNames.add(fileName),
      );
      setProgress(null);
    }
    await queryClient.invalidateQueries({ queryKey: ['issue-reports'] });
    // 送っている間に一覧から別の下書きを選ぶと、この画面は閉じる。画像は送り終えて一覧も読み直すが、作った下書きを選び直して
    // 利用者が選んだ下書きを奪わない (付いた画像は、その下書きを開けば見られる)。
    if (!mounted.current) return;
    if (failures.length === 0) {
      onCreated(draft);
    } else {
      setPartial({ draft, failures, storedFileNames });
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // 画像を送っている間は数秒かかる。もう一度の送信 (Enter など) で同じ報告の下書きを重ねて作らない。
    if (sending) {
      return;
    }
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
    let draft: IssueDraftSummaryDto;
    try {
      const response = await createManualIssueDraft({
        title,
        description,
        ...(project !== undefined ? { project } : {}),
      });
      draft = response.draft;
    } catch (caught) {
      // 下書きは作れていない。入力と画像はそのまま残し、画像は 1 枚も送らない。
      setError(describeIssueDraftManualError(caught));
      setSending(false);
      return;
    }
    // ここから先は、下書きが作れている。この先の失敗では、作った下書きを消さず、作り直さない。
    try {
      await finishCreated(draft, localAccess ? imageDraft.images : []);
    } finally {
      setSending(false);
    }
  };

  const retryFailedImages = async (outcome: PartialOutcome) => {
    const failedIds = new Set(outcome.failures.map((failure) => failure.id));
    const maybeStoredIds = new Set(outcome.failures.filter((failure) => failure.mayBeStored === true).map((failure) => failure.id));
    const failed = imageDraft.images.filter((image) => failedIds.has(image.id));
    setSending(true);
    try {
      // 送ったのに応答が届かなかった画像は、サーバーに保存できているかもしれない。同じ画像を二重に付けないよう、送る前に下書きの画像を
      // 取り直して、もう付いているものは送らない (サーバーが断った失敗は付いていないので、確かめない)。bdboard-8zwi。
      const alreadyStored = await findImagesAlreadyStored(
        outcome.draft.id,
        failed.filter((image) => maybeStoredIds.has(image.id)),
        outcome.storedFileNames,
      );
      await finishCreated(
        outcome.draft,
        failed.filter((image) => !alreadyStored.has(image.id)),
        new Set([...outcome.storedFileNames, ...alreadyStored.values()]),
      );
    } finally {
      setSending(false);
    }
  };

  if (partial !== null) {
    return (
      <IssueDraftImageFailures
        failures={failureItems}
        sending={sending}
        onRetry={() => void retryFailedImages(partial)}
        onOpen={() => onCreated(partial.draft)}
      />
    );
  }

  return (
    <form
      className="issue-draft-editor"
      aria-label="新しく報告"
      {...(localAccess ? imageDraft.formHandlers(sending) : {})}
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
        // 送信中 (画像を送っている数秒も含む) に直しても、作った下書きには入らない。黙って捨てないよう、読むだけにする。
        readOnly={sending}
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
        readOnly={sending}
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
      {localAccess && (
        <IssueDraftImagePicker
          images={imageDraft.images}
          problems={imageDraft.problems}
          notice={imageDraft.notice}
          disabled={sending}
          onAddFiles={imageDraft.addFiles}
          onRemove={imageDraft.remove}
        />
      )}
      {/* 進み具合の読み上げ。入れ物は常に置き、中身だけ替える (中身と一緒にあとから現れる status は、読み上げられないことがある。bdboard-8zwi)。 */}
      {localAccess && (
        <div role="status" aria-label="画像の送信の進み具合">
          {progress !== null && (
            <p className="issue-draft-editor-hint">
              画像を送っています ({progress.sent} / {progress.total})
            </p>
          )}
        </div>
      )}
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
