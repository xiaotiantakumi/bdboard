import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DetailField } from './DetailField';

// bdboard-sso1.5: DetailField は繰り返されていた「.detail-field > .detail-field-label +
// 値div」の DOM 構造をまとめただけの表示専用コンポーネント。移動前のインライン div と
// 同一の DOM 構造になっていることを検証する。
describe('DetailField', () => {
  it('renders the label and children inside the expected DOM structure', () => {
    const { container, getByText } = render(
      <DetailField label="MARK-label">MARK-value</DetailField>,
    );

    const root = container.querySelector('.detail-field');
    expect(root).not.toBeNull();
    expect(root?.children).toHaveLength(2);
    expect(root?.children[0]?.className).toBe('detail-field-label');
    expect(getByText('MARK-label')).toBeInTheDocument();
    expect(getByText('MARK-value')).toBeInTheDocument();
  });

  it('renders non-text children (e.g. a badge component) inside the value div', () => {
    const { container } = render(
      <DetailField label="PR">
        <span data-testid="marker-child">MARK-child</span>
      </DetailField>,
    );

    const valueDiv = container.querySelector('.detail-field > div:last-child');
    expect(valueDiv?.querySelector('[data-testid="marker-child"]')).not.toBeNull();
  });
});
