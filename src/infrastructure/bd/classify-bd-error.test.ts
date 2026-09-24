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

  // bdboard-vpt3: 負荷が高い時間帯に他プロジェクトの bd 読み取りが断続的に
  // context canceled でタイムアウトする件。bd は SIGTERM/SIGKILL を受けて
  // context を cancel してから終了するため、これらの文言が stderr に出る。
  describe('timeout classification (bdboard-vpt3)', () => {
    it('classifies "context canceled" as timeout', () => {
      expect(classifyBdError(1, "load custom types: context canceled")).toBe(
        'timeout',
      );
    });

    it('classifies "context deadline exceeded" as timeout', () => {
      expect(
        classifyBdError(1, 'begin read tx: context deadline exceeded'),
      ).toBe('timeout');
    });

    it('classifies a signal-terminated process (exitCode -1) with "context canceled" as timeout, not bd-not-found', () => {
      // NodeCommandRunner の finish() は SIGTERM/SIGKILL いずれでも 'close' で
      // code=null を -1 に潰す。exitCode だけを見る bd-not-found 判定
      // (exitCode === -1) より先に timeout を判定しないと、本当の原因
      // (タイムアウト) が隠れる。
      expect(classifyBdError(-1, 'begin read tx: context canceled')).toBe(
        'timeout',
      );
    });

    it('still classifies a plain exitCode -1 (e.g. spawn E2BIG, bdboard-xgvh) as bd-not-found', () => {
      // 回帰確認: timeout 判定を bd-not-found より先に置いても、"context
      // canceled" を含まない -1 のケースは従来どおり bd-not-found のまま。
      expect(classifyBdError(-1, 'spawn bd E2BIG')).toBe('bd-not-found');
    });

    it('classifies bd\'s own internal lock-wait deadline as lock-contention, not timeout', () => {
      // bd 自身が内部のロック待ちに deadline を設けていて、それを
      // "acquiring lock: ... context deadline exceeded" のように表現する
      // ことがある。文言上は TIMEOUT_PATTERN にも一致しうるが、これは
      // クライアント側 (NodeCommandRunner) の SIGTERM/SIGKILL によるもの
      // ではなく、短時間で解消しうる lock-contention として扱うべき
      // (classify-bd-error.ts の分岐順コメント参照)。
      expect(
        classifyBdError(1, 'acquiring lock: context deadline exceeded'),
      ).toBe('lock-contention');
    });
  });
});
