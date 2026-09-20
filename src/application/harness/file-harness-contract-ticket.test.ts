import { describe, expect, it, vi } from 'vitest';
import type { ContractState } from '../../domain/harness-contract.js';
import {
  HARNESS_CONTRACT_TICKET_LABEL,
  HARNESS_CONTRACT_TICKET_PRIORITY,
  HARNESS_CONTRACT_TICKET_TYPE,
} from '../../domain/harness-contract-ticket.js';
import {
  fileHarnessContractTicket,
  type HarnessContractTicketWriter,
} from './file-harness-contract-ticket.js';

const MISSING_CONTRACT: ContractState = { state: 'missing' };
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
  readonly existing?: { readonly id: string; readonly title: string } | null;
  readonly createdId?: string;
}): HarnessContractTicketWriter & {
  readonly findOpenTicketByLabel: ReturnType<typeof vi.fn>;
  readonly create: ReturnType<typeof vi.fn>;
} {
  return {
    findOpenTicketByLabel: vi.fn(async () => overrides?.existing ?? null),
    create: vi.fn(async () => ({ id: overrides?.createdId ?? 'proj-1' })),
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

  it('idempotency: creates a new ticket when none exists yet', async () => {
    const writer = createFakeWriter({ existing: null, createdId: 'proj-99' });

    const result = await fileHarnessContractTicket(
      writer,
      '/tmp/proj',
      MISSING_CONTRACT,
      ['verify'],
    );

    expect(result).toEqual({ ok: true, ticketId: 'proj-99', created: true });
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
      }),
    );
  });

  it('idempotency: returns the existing open ticket and does NOT create a duplicate', async () => {
    const writer = createFakeWriter({
      existing: { id: 'proj-42', title: 'already filed' },
    });

    const result = await fileHarnessContractTicket(
      writer,
      '/tmp/proj',
      MISSING_CONTRACT,
      ['verify'],
    );

    expect(result).toEqual({ ok: true, ticketId: 'proj-42', created: false });
    expect(writer.findOpenTicketByLabel).toHaveBeenCalledWith(
      '/tmp/proj',
      HARNESS_CONTRACT_TICKET_LABEL,
    );
    // The whole point of the idempotency guard: no second ticket gets created.
    expect(writer.create).not.toHaveBeenCalled();
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
    });
  });
});
