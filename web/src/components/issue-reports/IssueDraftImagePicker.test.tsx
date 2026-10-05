import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../test/axe';
import { hideObjectUrls, stubObjectUrls } from '../../test/objectUrls';
import { IssueDraftImagePicker } from './IssueDraftImagePicker';
import type { PickedImage } from './issueDraftImageUpload';

const PRIVACY_NOTE = '画像は手元にだけ保存され、公開 issue には自動では載りません。';

function sample(name: string, contents = 'abc'): PickedImage {
  return { id: `id-${name}`, name, file: new File([contents], name, { type: 'image/png' }) };
}

interface SetupOptions {
  readonly images?: readonly PickedImage[];
  readonly problems?: readonly string[];
  readonly notice?: string;
  readonly disabled?: boolean;
}

function setup({ images = [], problems = [], notice = '', disabled = false }: SetupOptions = {}) {
  const onAddFiles = vi.fn();
  const onRemove = vi.fn();
  const view = render(
    <IssueDraftImagePicker
      images={images}
      problems={problems}
      notice={notice}
      disabled={disabled}
      onAddFiles={onAddFiles}
      onRemove={onRemove}
    />,
  );
  return { onAddFiles, onRemove, view, user: userEvent.setup() };
}

const fileInput = () => screen.getByLabelText<HTMLInputElement>('画像のファイルを選ぶ');
const dropZone = () => screen.getByTestId('issue-draft-image-drop');

describe('IssueDraftImagePicker: the field (bdboard-4y8q.6.9)', () => {
  it('is a group named 画像 (任意) with the attached count out of 20', () => {
    setup({ images: [sample('a.png'), sample('b.png')] });
    expect(screen.getByRole('group', { name: '画像 (任意) 2 / 20' })).toBeInTheDocument();
  });

  it('describes the group with the limits and the ways to add, and with the privacy note', () => {
    setup();
    const group = screen.getByRole('group', { name: /画像 \(任意\)/ });
    expect(group).toHaveAccessibleDescription(/PNG・JPEG・WebP・GIF、1 枚 10 MiB まで、20 枚までです/);
    expect(group).toHaveAccessibleDescription(/貼り付ける \(Ctrl\+V \/ ⌘V\)、ここへドロップする、または「画像を選ぶ」/);
    expect(group).toHaveAccessibleDescription(new RegExp(PRIVACY_NOTE));
  });

  it('shows the privacy note as its own sentence', () => {
    setup();
    expect(screen.getByText(PRIVACY_NOTE)).toBeInTheDocument();
  });

  it('lists exactly the formats the server accepts in the file dialog and allows several files', () => {
    setup();
    expect(fileInput()).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/gif');
    expect(fileInput()).toHaveAttribute('multiple');
  });

  it('keeps the hidden file input out of the tab order so the button is the one control', () => {
    setup();
    expect(fileInput()).toHaveAttribute('tabindex', '-1');
    expect(fileInput()).toHaveAttribute('hidden');
  });

  it('shows no list and no alert when nothing is attached and nothing was refused', () => {
    setup();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('IssueDraftImagePicker: adding images', () => {
  it('reaches the choose button with Tab and opens the file dialog with Enter and with Space', async () => {
    const { user } = setup();
    const click = vi.spyOn(fileInput(), 'click');
    await user.tab();
    expect(screen.getByRole('button', { name: '画像を選ぶ' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(click).toHaveBeenCalledTimes(2);
  });

  it('hands the chosen files to onAddFiles', async () => {
    const { user, onAddFiles } = setup();
    const first = new File(['abc'], 'a.png', { type: 'image/png' });
    const second = new File(['def'], 'b.png', { type: 'image/png' });
    await user.upload(fileInput(), [first, second]);
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles).toHaveBeenCalledWith([first, second]);
  });

  it('empties the input after choosing, so the same file can be chosen again', async () => {
    const { user, onAddFiles } = setup();
    const chosen = new File(['abc'], 'a.png', { type: 'image/png' });
    await user.upload(fileInput(), chosen);
    await user.upload(fileInput(), chosen);
    expect(fileInput().value).toBe('');
    expect(onAddFiles).toHaveBeenCalledTimes(2);
  });

  it('hands dropped files to onAddFiles', () => {
    const { onAddFiles } = setup();
    const dropped = new File(['x'], 'drop.png', { type: 'image/png' });
    fireEvent.drop(dropZone(), { dataTransfer: { files: [dropped], types: ['Files'] } });
    expect(onAddFiles).toHaveBeenCalledWith([dropped]);
  });

  it('ignores a drop that carries no files (dragged text)', () => {
    const { onAddFiles } = setup();
    fireEvent.drop(dropZone(), { dataTransfer: { files: [], types: ['text/plain'] } });
    expect(onAddFiles).not.toHaveBeenCalled();
  });

  it('allows the drop (so the browser does not open the image) and highlights while a file is over the zone', () => {
    setup();
    const notCancelled = fireEvent.dragOver(dropZone(), { dataTransfer: { types: ['Files'] } });
    expect(notCancelled).toBe(false);
    expect(dropZone()).toHaveClass('is-dragging');
  });

  it('does not highlight for a drag that carries no files', () => {
    setup();
    fireEvent.dragOver(dropZone(), { dataTransfer: { types: ['text/plain'] } });
    expect(dropZone()).not.toHaveClass('is-dragging');
  });

  it('removes the highlight on drag leave and on drop', () => {
    setup();
    fireEvent.dragEnter(dropZone(), { dataTransfer: { types: ['Files'] } });
    expect(dropZone()).toHaveClass('is-dragging');
    fireEvent.dragLeave(dropZone());
    expect(dropZone()).not.toHaveClass('is-dragging');
    fireEvent.dragEnter(dropZone(), { dataTransfer: { types: ['Files'] } });
    fireEvent.drop(dropZone(), { dataTransfer: { files: [], types: ['Files'] } });
    expect(dropZone()).not.toHaveClass('is-dragging');
  });
});

describe('IssueDraftImagePicker: while disabled (sending)', () => {
  it('disables the choose button, the file input and every remove button', () => {
    setup({ images: [sample('a.png')], disabled: true });
    expect(screen.getByRole('button', { name: '画像を選ぶ' })).toBeDisabled();
    expect(fileInput()).toBeDisabled();
    expect(screen.getByRole('button', { name: '「a.png」を外す' })).toBeDisabled();
  });

  it('ignores a drop and does not highlight a drag', () => {
    const { onAddFiles } = setup({ disabled: true });
    fireEvent.dragOver(dropZone(), { dataTransfer: { types: ['Files'] } });
    expect(dropZone()).not.toHaveClass('is-dragging');
    fireEvent.drop(dropZone(), {
      dataTransfer: { files: [new File(['x'], 'late.png', { type: 'image/png' })], types: ['Files'] },
    });
    expect(onAddFiles).not.toHaveBeenCalled();
  });
});

describe('IssueDraftImagePicker: the list of attached images', () => {
  it('shows each image with its name and size in a list named 付ける画像', () => {
    setup({ images: [sample('a.png', 'abc'), sample('shot.png', 'x'.repeat(2048))] });
    const list = screen.getByRole('list', { name: '付ける画像' });
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(list).toContainElement(items[0] ?? null);
    expect(items[0]).toHaveTextContent('a.png');
    expect(items[0]).toHaveTextContent('1 KiB');
    expect(items[1]).toHaveTextContent('shot.png');
    expect(items[1]).toHaveTextContent('2 KiB');
  });

  it('names each remove button after its image', () => {
    setup({ images: [sample('a.png'), sample('b.png')] });
    expect(screen.getByRole('button', { name: '「a.png」を外す' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '「b.png」を外す' })).toBeInTheDocument();
  });

  it('calls onRemove with the id of the image and moves the focus to the choose button', async () => {
    const { user, onRemove } = setup({ images: [sample('a.png'), sample('b.png')] });
    await user.click(screen.getByRole('button', { name: '「b.png」を外す' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('id-b.png');
    expect(screen.getByRole('button', { name: '画像を選ぶ' })).toHaveFocus();
  });

  it('removes an image with the keyboard alone (Tab to the remove button, then Enter)', async () => {
    const { user, onRemove } = setup({ images: [sample('a.png')] });
    await user.tab();
    expect(screen.getByRole('button', { name: '画像を選ぶ' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '「a.png」を外す' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onRemove).toHaveBeenCalledWith('id-a.png');
  });
});

describe('IssueDraftImagePicker: refused images', () => {
  it('shows one alert with one item per reason', () => {
    setup({ problems: ['「a.svg」は付けられません。', '「b.png」は 10 MiB を超えているため付けられません。'] });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('「a.svg」は付けられません。');
    expect(alert).toHaveTextContent('「b.png」は 10 MiB を超えているため付けられません。');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows the same reason twice when two files were refused for the same reason', () => {
    setup({ problems: ['「image.png」は中身が空のため付けられません。', '「image.png」は中身が空のため付けられません。'] });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

// bdboard-8zwi: 付けた・外したは画面では見えるが、読み上げには届かなかった。polite な status で伝える。
describe('IssueDraftImagePicker: announcing what was attached or removed', () => {
  it('has a polite status container even when nothing was announced yet, so a later change is read out', () => {
    setup();
    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    expect(status).toBeEmptyDOMElement();
  });

  it('puts the notice in that same container and replaces it in place, not by adding a new status', () => {
    const { view, onAddFiles, onRemove } = setup({ notice: '1 枚の画像を付けました (全部で 1 枚)。' });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('1 枚の画像を付けました (全部で 1 枚)。');
    view.rerender(
      <IssueDraftImagePicker
        images={[]}
        problems={[]}
        notice="「a.png」を外しました (全部で 0 枚)。"
        disabled={false}
        onAddFiles={onAddFiles}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('「a.png」を外しました (全部で 0 枚)。');
  });

  it('keeps the notice out of sight (screen readers only) so it does not move the layout', () => {
    setup({ notice: '1 枚の画像を付けました (全部で 1 枚)。' });
    expect(screen.getByRole('status')).toHaveClass('sr-only');
  });

  it('has no accessibility violations with a notice', async () => {
    const { view } = setup({ images: [sample('a.png')], notice: '1 枚の画像を付けました (全部で 1 枚)。' });
    await expectNoA11yViolations(view.container);
  });
});

describe('IssueDraftImagePicker: thumbnails', () => {
  let urls: ReturnType<typeof stubObjectUrls>;

  beforeEach(() => {
    urls = stubObjectUrls();
  });

  afterEach(() => {
    urls.restore();
  });

  it('shows a thumbnail of the file, with the name in its alt text', () => {
    setup({ images: [sample('a.png'), sample('b.png')] });
    expect(urls.create).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('img', { name: 'a.png のプレビュー' })).toHaveAttribute('src', 'blob:preview-1');
    expect(screen.getByRole('img', { name: 'b.png のプレビュー' })).toHaveAttribute('src', 'blob:preview-2');
  });

  it('builds the thumbnail from the File itself, not from a data URL', () => {
    const image = sample('a.png');
    setup({ images: [image] });
    expect(urls.create).toHaveBeenCalledWith(image.file);
  });

  it('releases the object URL of an image that is removed from the list', () => {
    const first = sample('a.png');
    const second = sample('b.png');
    const { view } = setup({ images: [first, second] });
    view.rerender(
      <IssueDraftImagePicker images={[second]} problems={[]} notice="" disabled={false} onAddFiles={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(urls.revoke).toHaveBeenCalledTimes(1);
    expect(urls.revoke).toHaveBeenCalledWith('blob:preview-1');
    expect(screen.getByRole('img', { name: 'b.png のプレビュー' })).toHaveAttribute('src', 'blob:preview-2');
  });

  it('does not make a new object URL for an image that stays when another one is removed', () => {
    const first = sample('a.png');
    const second = sample('b.png');
    const { view } = setup({ images: [first, second] });
    view.rerender(
      <IssueDraftImagePicker images={[second]} problems={[]} notice="" disabled={false} onAddFiles={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(urls.create).toHaveBeenCalledTimes(2);
  });

  it('releases every object URL when the field goes away', () => {
    const { view } = setup({ images: [sample('a.png'), sample('b.png')] });
    view.unmount();
    expect(urls.revoke.mock.calls.map((call) => call[0]).sort()).toEqual(['blob:preview-1', 'blob:preview-2']);
  });
});

describe('IssueDraftImagePicker: without object URLs', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = hideObjectUrls();
  });

  afterEach(() => {
    restore();
  });

  it('still lists the name and size and does not fail when the browser cannot make a preview', () => {
    expect(typeof URL.createObjectURL).not.toBe('function');
    setup({ images: [sample('a.png')] });
    expect(screen.getByText('a.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '「a.png」を外す' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'a.png のプレビュー' })).not.toHaveAttribute('src');
  });
});

describe('IssueDraftImagePicker: accessibility checks (axe)', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = stubObjectUrls().restore;
  });

  afterEach(() => {
    restore();
  });

  it('has no violations when empty', async () => {
    const { view } = setup();
    await expectNoA11yViolations(view.container);
  });

  it('has no violations with images, refused images and while disabled', async () => {
    const { view } = setup({
      images: [sample('a.png'), sample('b.png')],
      problems: ['「c.svg」は付けられません。付けられる形式は PNG・JPEG・WebP・GIF です。'],
      disabled: true,
    });
    await expectNoA11yViolations(view.container);
  });
});
