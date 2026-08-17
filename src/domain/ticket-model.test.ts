import { describe, expect, it } from 'vitest';
import { parseTicketModelRecords } from './ticket-model.js';

describe('parseTicketModelRecords', () => {
  it('returns [] for undefined metadata', () => {
    expect(parseTicketModelRecords(undefined)).toEqual([]);
  });

  it('sorts known stages in implement → test → review → check order regardless of input order', () => {
    const result = parseTicketModelRecords({
      'bdboard.model.check': 'gpt',
      'bdboard.model.implement': 'composer-2.5',
      'bdboard.model.review': 'fable',
      'bdboard.model.test': 'opus',
    });

    expect(result).toEqual([
      { stage: 'implement', model: 'composer-2.5' },
      { stage: 'test', model: 'opus' },
      { stage: 'review', model: 'fable' },
      { stage: 'check', model: 'gpt' },
    ]);
  });

  it('places unknown stages after known stages in alphabetical order', () => {
    const result = parseTicketModelRecords({
      'bdboard.model.alpha': 'model-a',
      'bdboard.model.implement': 'composer-2.5',
      'bdboard.model.zeta': 'model-z',
      'bdboard.model.beta': 'model-b',
    });

    expect(result).toEqual([
      { stage: 'implement', model: 'composer-2.5' },
      { stage: 'alpha', model: 'model-a' },
      { stage: 'beta', model: 'model-b' },
      { stage: 'zeta', model: 'model-z' },
    ]);
  });

  it('ignores keys that do not start with bdboard.model.', () => {
    const result = parseTicketModelRecords({
      'bdboard.session': 'sess-1',
      'bdboard.model.implement': 'composer-2.5',
      other: 'x',
    });

    expect(result).toEqual([{ stage: 'implement', model: 'composer-2.5' }]);
  });

  it('drops non-string, empty, and whitespace-only values', () => {
    const result = parseTicketModelRecords({
      'bdboard.model.implement': 'composer-2.5',
      'bdboard.model.test': '',
      'bdboard.model.review': '   ',
      'bdboard.model.check': 42,
      'bdboard.model.alpha': null,
    });

    expect(result).toEqual([{ stage: 'implement', model: 'composer-2.5' }]);
  });

  it('trims model values', () => {
    const result = parseTicketModelRecords({
      'bdboard.model.implement': '  composer-2.5  ',
    });

    expect(result).toEqual([{ stage: 'implement', model: 'composer-2.5' }]);
  });

  it('drops keys that are exactly bdboard.model. (empty stage)', () => {
    const result = parseTicketModelRecords({
      'bdboard.model.': 'orphan',
      'bdboard.model.implement': 'composer-2.5',
    });

    expect(result).toEqual([{ stage: 'implement', model: 'composer-2.5' }]);
  });

  it('preserves stage case without normalization', () => {
    const result = parseTicketModelRecords({
      'bdboard.model.Implement': 'upper',
      'bdboard.model.implement': 'lower',
    });

    expect(result).toEqual([
      { stage: 'implement', model: 'lower' },
      { stage: 'Implement', model: 'upper' },
    ]);
  });
});
