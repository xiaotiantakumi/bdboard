import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { formatImageSize } from '../chat/attachments';
import { ISSUE_DRAFT_IMAGE_MAX_COUNT } from './issueDraftImageLimits';
import type { PickedImage } from './issueDraftImageUpload';

export interface IssueDraftImagePickerProps {
  readonly images: readonly PickedImage[];
  readonly problems: readonly string[];
  readonly disabled: boolean;
  readonly onAddFiles: (files: readonly File[]) => void;
  readonly onRemove: (id: string) => void;
}

function ImageThumb({ file, name }: { readonly file: File; readonly name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return;
    const objectUrl = URL.createObjectURL(file);
    const frame = window.requestAnimationFrame(() => setUrl(objectUrl));
    return () => { window.cancelAnimationFrame(frame); URL.revokeObjectURL(objectUrl); };
  }, [file]);
  return url === null ? null : <img alt={`${name} のプレビュー`} className="issue-draft-image-thumb" src={url} />;
}

export function IssueDraftImagePicker({ images, problems, disabled, onAddFiles, onRemove }: IssueDraftImagePickerProps) {
  const descriptionId = useId();
  const noteId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = (event: ChangeEvent<HTMLInputElement>) => {
    onAddFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = '';
  };
  const hasFiles = (event: DragEvent<HTMLDivElement>) => Array.from(event.dataTransfer.types).includes('Files');
  return (
    <fieldset className="issue-draft-image-picker" aria-describedby={`${descriptionId} ${noteId}`}>
      <legend>画像 (任意) <span>{images.length} / {ISSUE_DRAFT_IMAGE_MAX_COUNT}</span></legend>
      <p className="issue-draft-editor-hint" id={descriptionId}>
        PNG・JPEG・WebP・GIF、1 枚 10 MiB まで、20 枚までです。この画面で貼り付ける (Ctrl+V / ⌘V)、ここへドロップする、または「画像を選ぶ」から選べます。
      </p>
      <p className="issue-draft-editor-hint" id={noteId}>画像は手元にだけ保存され、公開 issue には自動では載りません。</p>
      <div
        className={`issue-draft-image-drop${dragging ? ' is-dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); if (hasFiles(event)) setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); if (hasFiles(event)) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled) return;
          const files = Array.from(event.dataTransfer.files);
          if (files.length > 0) onAddFiles(files);
        }}
      >
        <button ref={buttonRef} type="button" className="btn" disabled={disabled} onClick={() => inputRef.current?.click()}>画像を選ぶ</button>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label="画像のファイルを選ぶ"
          tabIndex={-1}
          disabled={disabled}
          onChange={fileInput}
        />
      </div>
      {problems.length > 0 && <ul className="error-message" role="alert">{problems.map((problem, index) => <li key={`${problem}-${index}`}>{problem}</li>)}</ul>}
      {images.length > 0 && (
        <ul className="issue-draft-image-list" aria-label="付ける画像">
          {images.map((image) => (
            <li key={image.id}>
              <ImageThumb file={image.file} name={image.name} />
              <span className="issue-draft-image-name">{image.name}</span>
              <span>{formatImageSize(image.file.size)}</span>
              <button
                type="button"
                className="btn"
                aria-label={`「${image.name}」を外す`}
                disabled={disabled}
                onClick={() => { onRemove(image.id); buttonRef.current?.focus(); }}
              >外す</button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
