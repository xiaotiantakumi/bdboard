import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueDraftEditor } from './IssueDraftEditor';
import type { IssueDraftDetailDto } from '../../api/issue-reports';

vi.mock('../../api/issue-reports', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/issue-reports')>()), patchIssueDraft: vi.fn() }));
import { patchIssueDraft } from '../../api/issue-reports';
const draft: IssueDraftDetailDto = {
  id: '1758812345678-a1b2c3d4e5f6a7b8', kind: 'B', fingerprint: 'B:hook:abcd', title: 'title', body: 'body', status: 'pending',
  occurrenceCount: 1, firstOccurredAt: '2026-10-01T00:00:00.000Z', lastOccurredAt: '2026-10-01T00:00:00.000Z', occurredProjectCount: 0,
  titleEditedByUser: true, bodyEditedByUser: true, localOnly: { errorTextTruncated: false, envInfo: {} }, occurredProjects: [], restricted: true,
};
describe('IssueDraftEditor reset hint', () => {
  beforeEach(() => vi.mocked(patchIssueDraft).mockReset());
  it('shows the reset hint and sends an empty edited body', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft, errorTextTrimmed: false });
    render(<QueryClientProvider client={new QueryClient()}><IssueDraftEditor draft={draft} onCancel={vi.fn()} onSaved={vi.fn()} /></QueryClientProvider>);
    expect(screen.getByText('題名や本文を空にして保存すると、自動で組んだ内容に戻ります。')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/本文/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await vi.waitFor(() => expect(patchIssueDraft).toHaveBeenCalledWith(draft.id, { body: '' }));
  });
});
