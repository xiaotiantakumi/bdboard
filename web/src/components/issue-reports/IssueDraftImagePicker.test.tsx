import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IssueDraftImagePicker } from './IssueDraftImagePicker';
import type { PickedImage } from './issueDraftImageUpload';

function sample(name: string): PickedImage {
  return { id: name, name, file: new File(['abc'], name, { type: 'image/png' }) };
}

function setup(images: readonly PickedImage[] = [], disabled = false, problems: readonly string[] = []) {
  const onAddFiles = vi.fn();
  const onRemove = vi.fn();
  render(<IssueDraftImagePicker images={images} problems={problems} disabled={disabled} onAddFiles={onAddFiles} onRemove={onRemove} />);
  return { onAddFiles, onRemove };
}

describe('IssueDraftImagePicker', () => {
  it('shows the heading, count, guidance and exact privacy note as its accessible description', () => {
    setup([sample('a.png'), sample('b.png')]);
    const group = screen.getByRole('group', { name: /画像 \(任意\)/ });
    expect(group).toHaveAccessibleDescription(/PNG・JPEG・WebP・GIF/);
    expect(group).toHaveAccessibleDescription(/画像は手元にだけ保存され、公開 issue には自動では載りません。/);
    expect(screen.getByText('2 / 20')).toBeInTheDocument();
  });
  it('provides the exact accepted MIME list and multiple selection', () => {
    setup();
    expect(screen.getByLabelText('画像のファイルを選ぶ')).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/gif');
    expect(screen.getByLabelText('画像のファイルを選ぶ')).toHaveAttribute('multiple');
  });
  it('opens the file input with Enter from the picker button', async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByLabelText('画像のファイルを選ぶ');
    const click = vi.spyOn(input, 'click');
    screen.getByRole('button', { name: '画像を選ぶ' }).focus();
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalledOnce();
  });
  it('adds selected files and clears the input so the same file can be selected again', async () => {
    const user = userEvent.setup();
    const { onAddFiles } = setup();
    const input = screen.getByLabelText('画像のファイルを選ぶ') as HTMLInputElement;
    const chosen = new File(['abc'], 'a.png', { type: 'image/png' });
    await user.upload(input, chosen);
    expect(onAddFiles).toHaveBeenCalledWith([chosen]);
    expect(input.value).toBe('');
  });
  it('adds dropped files and ignores a non-file drop', () => {
    const { onAddFiles } = setup();
    const zone = screen.getByRole('button', { name: '画像を選ぶ' }).parentElement!;
    const chosen = new File(['x'], 'a.png', { type: 'image/png' });
    fireEvent.drop(zone, { dataTransfer: { files: [chosen], types: ['Files'] } });
    fireEvent.drop(zone, { dataTransfer: { files: [], types: ['text/plain'] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles).toHaveBeenCalledWith([chosen]);
  });
  it('highlights file drags and removes the highlight on drag leave', () => {
    setup();
    const zone = screen.getByRole('button', { name: '画像を選ぶ' }).parentElement!;
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'] } });
    expect(zone).toHaveClass('is-dragging');
    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveClass('is-dragging');
  });
  it('disables picker controls and ignores dropped files while disabled', () => {
    const { onAddFiles } = setup([sample('a.png')], true);
    expect(screen.getByRole('button', { name: '画像を選ぶ' })).toBeDisabled();
    expect(screen.getByLabelText('画像のファイルを選ぶ')).toBeDisabled();
    expect(screen.getByRole('button', { name: '「a.png」を外す' })).toBeDisabled();
    fireEvent.drop(screen.getByRole('button', { name: '画像を選ぶ' }).parentElement!, {
      dataTransfer: { files: [new File(['x'], 'b.png', { type: 'image/png' })], types: ['Files'] },
    });
    expect(onAddFiles).not.toHaveBeenCalled();
  });
  it('removes an image and moves focus to the add button', async () => {
    const user = userEvent.setup();
    const { onRemove } = setup([sample('a.png')]);
    await user.click(screen.getByRole('button', { name: '「a.png」を外す' }));
    expect(onRemove).toHaveBeenCalledWith('a.png');
    expect(screen.getByRole('button', { name: '画像を選ぶ' })).toHaveFocus();
  });
  it('shows one alert item for each screening problem', () => {
    setup([], false, ['first', 'second']);
    expect(screen.getByRole('alert').querySelectorAll('li')).toHaveLength(2);
  });
  it('creates and revokes thumbnail object URLs', async () => {
    const oldCreate = URL.createObjectURL;
    const oldRevoke = URL.revokeObjectURL;
    const create = vi.fn(() => 'blob:test');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const view = render(<IssueDraftImagePicker images={[sample('a.png')]} problems={[]} disabled={false} onAddFiles={vi.fn()} onRemove={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'a.png のプレビュー' })).toHaveAttribute('src', 'blob:test'));
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:test');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: oldCreate });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: oldRevoke });
  });
  it('does not fail when object URL creation is unavailable', () => {
    const oldCreate = URL.createObjectURL;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: undefined });
    setup([sample('a.png')]);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('a.png')).toBeInTheDocument();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: oldCreate });
  });
});
