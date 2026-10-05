import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { formatImageSize } from '../chat/attachments';
import { ISSUE_DRAFT_IMAGE_MAX_COUNT, ISSUE_DRAFT_IMAGE_MIME_TYPES } from './issueDraftImageLimits';
import { ISSUE_DRAFT_IMAGE_FORMAT_LABEL, ISSUE_DRAFT_IMAGE_MAX_SIZE_LABEL, dragCarriesFiles } from './issueDraftImages';
import type { PickedImage } from './issueDraftImageUpload';

export interface IssueDraftImagePickerProps {
  readonly images: readonly PickedImage[];
  /** 直近の追加で断った理由。 */
  readonly problems: readonly string[];
  /** 送信中。追加・外す・ドロップをすべて止める。 */
  readonly disabled: boolean;
  readonly onAddFiles: (files: readonly File[]) => void;
  readonly onRemove: (id: string) => void;
}

/** ファイル選択の accept。付けられる形式の一覧から作る (ファイル選択の絞り込みだけで、検査の正は screenIssueDraftImages)。 */
const FILE_INPUT_ACCEPT = ISSUE_DRAFT_IMAGE_MIME_TYPES.join(',');

/**
 * 縮小表示。File から object URL を作り、外したとき・閉じたときに手放す (data URL を 20 枚ぶん持たない)。
 * URL は effect の中で作る: 描画の中で作ると、StrictMode の二重実行で手放し損ねた URL が残る。
 * state ではなく img の src へ直接入れるので、URL ができるたびの再描画は起きない。
 */
function ImageThumb({ file, name }: { readonly file: File; readonly name: string }) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (image === null || typeof URL.createObjectURL !== 'function') {
      return undefined;
    }
    const objectUrl = URL.createObjectURL(file);
    image.src = objectUrl;
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return <img ref={imageRef} className="issue-draft-image-thumb" alt={`${name} のプレビュー`} />;
}

/**
 * 「新しく報告」の書く画面の、画像を付ける欄 (bdboard-4y8q.6.9)。入れ方はこの欄のドロップと「画像を選ぶ」
 * (貼り付けと、この欄の外に落としたファイルは書く画面全体で受けるので、親の form が処理する。useIssueDraftImages の formHandlers)。
 * この欄で受けたドロップは preventDefault するので、親の form は重ねて足さない。状態は持たず、検査と一覧は親 (useIssueDraftImages) が持つ。
 * キーボードだけで、追加は「画像を選ぶ」ボタン、取り消しは各画像の「外す」ボタンでできる。
 */
export function IssueDraftImagePicker({ images, problems, disabled, onAddFiles, onRemove }: IssueDraftImagePickerProps) {
  const guideId = useId();
  const noteId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseButtonRef = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleChoose = (event: ChangeEvent<HTMLInputElement>) => {
    onAddFiles(Array.from(event.currentTarget.files ?? []));
    // 同じファイルをもう一度選んでも change が起きるように、選んだ値は残さない。
    event.currentTarget.value = '';
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    // preventDefault しないと drop が起きず、ブラウザがその画像を開いてしまう。
    event.preventDefault();
    setDragging(!disabled && dragCarriesFiles(event.dataTransfer));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) {
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      onAddFiles(files);
    }
  };

  return (
    <fieldset className="issue-draft-image-picker" aria-describedby={`${guideId} ${noteId}`}>
      <legend>
        画像 (任意)
        <span className="issue-draft-editor-count">
          {' '}
          {images.length} / {ISSUE_DRAFT_IMAGE_MAX_COUNT}
        </span>
      </legend>
      <p className="issue-draft-editor-hint" id={guideId}>
        {ISSUE_DRAFT_IMAGE_FORMAT_LABEL}、1 枚 {ISSUE_DRAFT_IMAGE_MAX_SIZE_LABEL} まで、{ISSUE_DRAFT_IMAGE_MAX_COUNT} 枚までです。
        この画面で貼り付ける (Ctrl+V / ⌘V)、ここへドロップする、または「画像を選ぶ」から選べます。
      </p>
      <p className="issue-draft-editor-hint" id={noteId}>
        画像は手元にだけ保存され、公開 issue には自動では載りません。
      </p>
      <div
        className={`issue-draft-image-drop${dragging ? ' is-dragging' : ''}`}
        data-testid="issue-draft-image-drop"
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <button
          ref={chooseButtonRef}
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          画像を選ぶ
        </button>
        {/* 見えない input。押せるのは上のボタンで、キーボードの Tab もそちらに止める。 */}
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept={FILE_INPUT_ACCEPT}
          aria-label="画像のファイルを選ぶ"
          tabIndex={-1}
          disabled={disabled}
          onChange={handleChoose}
        />
      </div>
      {problems.length > 0 && (
        // role="alert" は ul に付けない (list の役割が上書きされ、li が箱なしになる)。外の div で読み上げさせる。
        <div className="error-message issue-draft-image-problems" role="alert">
          <ul className="issue-draft-image-problem-list">
            {problems.map((problem, index) => (
              // 同じ名前の画像 (貼り付けは image.png ばかり) が同じ理由で断られると文が重なるので、位置も鍵に入れる。
              <li key={`${index}:${problem}`}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {images.length > 0 && (
        <ul className="issue-draft-image-list" aria-label="付ける画像">
          {images.map((image) => (
            <li key={image.id}>
              <ImageThumb file={image.file} name={image.name} />
              <span className="issue-draft-image-name">{image.name}</span>
              <span className="issue-draft-editor-count">{formatImageSize(image.file.size)}</span>
              <button
                type="button"
                className="btn issue-draft-image-remove"
                aria-label={`「${image.name}」を外す`}
                disabled={disabled}
                onClick={() => {
                  onRemove(image.id);
                  // 押したボタンは消えるので、フォーカスが body へ落ちないよう、欄の入口へ戻す。
                  chooseButtonRef.current?.focus();
                }}
              >
                外す
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
