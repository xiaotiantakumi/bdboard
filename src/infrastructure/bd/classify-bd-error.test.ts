import { describe, expect, it } from 'vitest';
import { classifyBdError } from './classify-bd-error.js';

describe('classifyBdError', () => {
  describe('false positives avoided (regression)', () => {
    it('does not classify "blocked by:" dependency messages as lock-contention', () => {
      expect(classifyBdError(1, 'blocked by: bdboard-123')).toBe('unknown');
    });

    it('does not classify "[blocked]" close errors as lock-contention', () => {
      expect(
        classifyBdError(1, '[blocked] cannot close: unresolved dependency'),
      ).toBe('unknown');
    });

    it('does not classify "unblocked" as lock-contention', () => {
      expect(classifyBdError(1, 'unblocked bdboard-123')).toBe('unknown');
    });

    it('does not classify "skip_blocked" as lock-contention', () => {
      expect(classifyBdError(1, 'skip_blocked=true')).toBe('unknown');
    });

    it('does not classify "branch not found" as bd-not-found', () => {
      expect(classifyBdError(1, 'branch not found')).toBe('unknown');
    });

    it('does not classify "target not found" as bd-not-found', () => {
      expect(classifyBdError(1, 'target not found')).toBe('unknown');
    });

    it('does not classify "policy not found" as bd-not-found', () => {
      expect(classifyBdError(1, 'policy not found')).toBe('unknown');
    });
  });

  describe('correct classification preserved', () => {
    it('classifies database lock errors as lock-contention', () => {
      expect(classifyBdError(1, 'database is locked')).toBe('lock-contention');
    });

    it('classifies lock contention messages as lock-contention', () => {
      expect(classifyBdError(1, 'lock contention, retry later')).toBe(
        'lock-contention',
      );
    });

    it('classifies exit 127 with command not found as bd-not-found', () => {
      expect(classifyBdError(127, 'bd: command not found')).toBe('bd-not-found');
    });

    it('classifies spawn enoent as bd-not-found', () => {
      expect(classifyBdError(-1, 'spawn bd enoent')).toBe('bd-not-found');
    });

    it('classifies "bd not found" as bd-not-found', () => {
      expect(classifyBdError(1, 'bd not found')).toBe('bd-not-found');
    });

    it('classifies "not a beads project" as not-a-beads-project', () => {
      expect(classifyBdError(1, 'not a beads project')).toBe(
        'not-a-beads-project',
      );
    });

    it('classifies ".beads not found" as not-a-beads-project before bd-not-found', () => {
      expect(classifyBdError(1, '.beads not found')).toBe('not-a-beads-project');
    });

    it('classifies unexpected output as unknown', () => {
      expect(classifyBdError(1, 'something unexpected happened')).toBe('unknown');
    });
  });
});
