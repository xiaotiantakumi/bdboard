import { useRef, useState, type ClipboardEvent } from 'react';
import { screenIssueDraftImages } from './issueDraftImages';
import type { PickedImage } from './issueDraftImageUpload';

export interface UseIssueDraftImages {
  readonly images: readonly PickedImage[];
  readonly problems: readonly string[];
  readonly addFiles: (files: readonly File[]) => void;
  readonly remove: (id: string) => void;
  readonly handlePaste: (event: ClipboardEvent<HTMLElement>) => void;
}

/** 最新の画像一覧を ref にも持ち、同一イベント内の連続追加でも上限を守る。 */
export function useIssueDraftImages(): UseIssueDraftImages {
  const [images, setImages] = useState<PickedImage[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const imagesRef = useRef<PickedImage[]>([]);
  const nextId = useRef(0);
  const addFiles = (files: readonly File[]) => {
    const screened = screenIssueDraftImages(imagesRef.current.length, files);
    const added = screened.accepted.map((file) => {
      nextId.current += 1;
      return { id: `draft-image-${nextId.current}`, file, name: file.name || `貼り付け画像 ${nextId.current}` };
    });
    imagesRef.current = [...imagesRef.current, ...added];
    setImages(imagesRef.current);
    setProblems(screened.problems);
  };
  const remove = (id: string) => {
    imagesRef.current = imagesRef.current.filter((image) => image.id !== id);
    setImages(imagesRef.current);
    setProblems([]);
  };
  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };
  return { images, problems, addFiles, remove, handlePaste };
}
