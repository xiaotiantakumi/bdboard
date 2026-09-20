import { describe, expect, it, vi } from 'vitest';
import type { ContractState } from '../../domain/harness-contract.js';
import {
  HARNESS_CONTRACT_TICKET_LABEL,
  HARNESS_CONTRACT_TICKET_PRIORITY,
  HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY,
  HARNESS_CONTRACT_TICKET_TYPE,
} from '../../domain/harness-contract-ticket.js';
import {
  fileHarnessContractTicket,
  type HarnessContractTicketWriter,
} from './file-harness-contract-ticket.js';

const MISSING_CONTRACT: ContractState = { state: 'missing' };
const INVALID_CONTRACT: ContractState = { state: 'invalid', message: 'bad json' };
const OK_CONTRACT: ContractState = {
  state: 'ok',
  verify: 'npm run verify',
  prFlow: 'pr',
  mainBranch: 'main',
  models: null,
  expiredExcludeCount: 0,
  modelExclusionWarnings: [],
};

function createFakeWriter(overrides?: {
  readonly existing?:
    | {
        readonly id: string;
        readonly title: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }
    | null;
  readonly createdId?: string;
  readonly addCommentImpl?: () => Promise<void>;
  readonly setMetadataImpl?: () => Promise<void>;
}): HarnessContractTicketWriter & {
  readonly findOpenTicketByLabel: ReturnType<typeof vi.fn>;
  readonly create: ReturnType<typeof vi.fn>;
  readonly addComment: ReturnType<typeof vi.fn>;
  readonly setMetadata: ReturnType<typeof vi.fn>;
} {
  const existing = overrides?.existing;
  return {
    findOpenTicketByLabel: vi.fn(async () =>
      existing === undefined
        ? null
        : existing === null
          ? null
          : { ...existing, metadata: existing.metadata ?? {} },
    ),
    create: vi.fn(async () => ({ id: overrides?.createdId ?? 'proj-1' })),
    addComment: vi.fn(overrides?.addCommentImpl ?? (async () => {})),
    setMetadata: vi.fn(overrides?.setMetadataImpl ?? (async () => {})),
  };
}

describe('fileHarnessContractTicket', () => {
  it('returns ok:false/not-applicable and skips the issue writer entirely for an "ok" contract', async () => {
    const writer = createFakeWriter();
    const result = await fileHarnessContractTicket(
      writer,
      '/tmp/proj',
      OK_CONTRACT,
      null,
    );
    expect(result).toEqual({ ok: false, reason: 'not-applicable' });
    expect(writer.findOpenTicketByLabel).not.toHaveBeenCalled();
    expect(writer.create).not.toHaveBeenCalled();
  });

  it('returns ok:false/not-applicable for a "not-applicable" contract', async () => {
    const writer = createFakeWriter();
    const result = await fileHarnessContractTicket(
      writer,
      '/tmp/proj',
      { state: 'not-applicable' },
      null,
    );
    expect(result).toEqual({ ok: false, reason: 'not-applicable' });
    expect(writer.findOpenTicketByLabel).not.toHaveBeenCalled();
  });

  it('idempotency: creates a new ticket (with the current state recorded as metadata) when none exists yet', async () => {
    const writer = createFakeWriter({ existing: null, createdId: 'proj-99' });

    const result = await fileHarnessContractTicket(
      writer,
      '/tmp/proj',
      MISSING_CONTRACT,
      ['verify'],
    );

    expect(result).toEqual({
      ok: true,
      ticketId: 'proj-99',
      created: true,
      stateAppend: 'not-needed',
    });
    expect(writer.findOpenTicketByLabel).toHaveBeenCalledWith(
      '/tmp/proj',
      HARNESS_CONTRACT_TICKET_LABEL,
    );
    expect(writer.create).toHaveBeenCalledTimes(1);
    expect(writer.create).toHaveBeenCalledWith(
      '/tmp/proj',
      expect.objectContaining({
        type: HARNESS_CONTRACT_TICKET_TYPE,
        priority: HARNESS_CONTRACT_TICKET_PRIORITY,
        labels: [HARNESS_CONTRACT_TICKET_LABEL],
        metadata: { [HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY]: 'missing' },
      }),
    );
    // 新規作成パスでは追記の必要が無い (state は作成時点のメタデータに載せ済み)。
    expect(writer.addComment).not.toHaveBeenCalled();
    expect(writer.setMetadata).not.toHaveBeenCalled();
  });

  it('idempotency: returns the existing open ticket and does NOT create a duplicate when the recorded state matches', async () => {
    const writer = createFakeWriter({
      existing: {
        id: 'proj-42',
        title: 'already filed',
        metadata: { [HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY]: 'missing' },
      },
    });

    const result = await fileHarnessContractTicket(
      writer,
      '/tmp/proj',
      MISSING_CONTRACT,
      ['verify'],
    );

    expect(result).toEqual({
      ok: true,
      ticketId: 'proj-42',
      created: false,
      stateAppend: 'not-needed',
    });
    expect(writer.findOpenTicketByLabel).toHaveBeenCalledWith(
      '/tmp/proj',
      HARNESS_CONTRACT_TICKET_LABEL,
    );
    // The whole point of the idempotency guard: no second ticket gets created.
    expect(writer.create).not.toHaveBeenCalled();
    // Same recorded state as current: no comment spam on repeated clicks.
    expect(writer.addComment).not.toHaveBeenCalled();
    expect(writer.setMetadata).not.toHaveBeenCalled();
  });

  // bdboard-13mp: state 遷移をまたいだ陳腐化チケットの扱いの核 — 記録済み state と
  // 現在の state が違うときだけ追記する。
  describe('state transition across an existing ticket (bdboard-13mp)', () => {
    it('appends a state-change comment and updates the recorded metadata when the state differs', async () => {
      const writer = createFakeWriter({
        existing: {
          id: 'proj-42',
          title: 'already filed',
          metadata: { [HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY]: 'missing' },
        },
      });

      const result = await fileHarnessContractTicket(
        writer,
        '/tmp/proj',
        INVALID_CONTRACT,
        null,
      );

      expect(result).toEqual({
        ok: true,
        ticketId: 'proj-42',
        created: false,
        stateAppend: 'appended',
      });
      expect(writer.create).not.toHaveBeenCalled();
      expect(writer.addComment).toHaveBeenCalledTimes(1);
      const [rootPath, ticketId, text] = writer.addComment.mock.calls[0] as [
        string,
        string,
        string,
      ];
      expect(rootPath).toBe('/tmp/proj');
      expect(ticketId).toBe('proj-42');
      // 本文は現在の state (invalid) 向けの対処内容を含む — 起票時と同じビルダーの
      // description をそのまま再利用している。
      expect(text).toContain('現在の状態は invalid です');
      expect(text).toContain('bad json');
      expect(writer.setMetadata).toHaveBeenCalledWith(
        '/tmp/proj',
        'proj-42',
        HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY,
        'invalid',
      );
    });

    it('treats a legacy ticket with no recorded state as "unknown" and appends exactly once', async () => {
      const writer = createFakeWriter({
        existing: { id: 'proj-legacy', title: 'pre-bdboard-13mp ticket' },
      });

      const result = await fileHarnessContractTicket(
        writer,
        '/tmp/proj',
        MISSING_CONTRACT,
        null,
      );

      expect(result).toEqual({
        ok: true,
        ticketId: 'proj-legacy',
        created: false,
        stateAppend: 'appended',
      });
      expect(writer.addComment).toHaveBeenCalledTimes(1);
      expect(writer.setMetadata).toHaveBeenCalledWith(
        '/tmp/proj',
        'proj-legacy',
        HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY,
        'missing',
      );
    });

    it('is fail-soft: a failed comment/metadata write still returns the existing ticket id, flagged as failed', async () => {
      const writer = createFakeWriter({
        existing: {
          id: 'proj-42',
          title: 'already filed',
          metadata: { [HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY]: 'missing' },
        },
        addCommentImpl: async () => {
          throw new Error('bd comment failed: lock held');
        },
      });
      const logWarn = vi.fn();

      const result = await fileHarnessContractTicket(
        writer,
        '/tmp/proj',
        INVALID_CONTRACT,
        null,
        { logWarn },
      );

      expect(result).toEqual({
        ok: true,
        ticketId: 'proj-42',
        created: false,
        stateAppend: 'failed',
      });
      // setMetadata must not run after addComment threw (sequential, not Promise.all).
      expect(writer.setMetadata).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn.mock.calls[0]?.[0]).toContain('proj-42');
    });

    it('is fail-soft when addComment succeeds but setMetadata throws', async () => {
      const writer = createFakeWriter({
        existing: {
          id: 'proj-42',
          title: 'already filed',
          metadata: { [HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY]: 'missing' },
        },
        setMetadataImpl: async () => {
          throw new Error('bd update failed');
        },
      });

      const result = await fileHarnessContractTicket(
        writer,
        '/tmp/proj',
        INVALID_CONTRACT,
        null,
      );

      expect(result).toEqual({
        ok: true,
        ticketId: 'proj-42',
        created: false,
        stateAppend: 'failed',
      });
      // The comment itself did go through even though the metadata write failed.
      expect(writer.addComment).toHaveBeenCalledTimes(1);
    });
  });

  it('builds content per contract state (invalid/command-missing also produce a ticket)', async () => {
    const writerInvalid = createFakeWriter({ createdId: 'proj-invalid' });
    const invalidResult = await fileHarnessContractTicket(
      writerInvalid,
      '/tmp/proj',
      { state: 'invalid', message: 'bad json' },
      null,
    );
    expect(invalidResult).toEqual({
      ok: true,
      ticketId: 'proj-invalid',
      created: true,
      stateAppend: 'not-needed',
    });

    const writerCommandMissing = createFakeWriter({ createdId: 'proj-cmd' });
    const commandMissingResult = await fileHarnessContractTicket(
      writerCommandMissing,
      '/tmp/proj',
      { state: 'command-missing', script: 'verify', verify: 'npm run verify' },
      null,
    );
    expect(commandMissingResult).toEqual({
      ok: true,
      ticketId: 'proj-cmd',
      created: true,
      stateAppend: 'not-needed',
    });
  });
});
