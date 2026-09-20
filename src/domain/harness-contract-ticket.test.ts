import { describe, expect, it } from 'vitest';
import { HARNESS_CONTRACT_RELATIVE_PATH, type ContractState } from './harness-contract.js';
import {
  HARNESS_CONTRACT_TICKET_LABEL,
  HARNESS_CONTRACT_TICKET_PRIORITY,
  HARNESS_CONTRACT_TICKET_TYPE,
  buildHarnessContractTicketContent,
  suggestVerifyCommand,
} from './harness-contract-ticket.js';

describe('suggestVerifyCommand', () => {
  it('returns null when scripts are absent', () => {
    expect(suggestVerifyCommand('absent')).toBeNull();
  });

  it('returns null when scripts are unreadable (null)', () => {
    expect(suggestVerifyCommand(null)).toBeNull();
  });

  it('returns null for an empty scripts list', () => {
    expect(suggestVerifyCommand([])).toBeNull();
  });

  it('prefers an exact "verify" script name', () => {
    expect(suggestVerifyCommand(['verify', 'build', 'test'])).toBe('npm run verify');
  });

  it('falls back to "ci" then "check" when "verify" is absent', () => {
    expect(suggestVerifyCommand(['ci', 'build'])).toBe('npm run ci');
    expect(suggestVerifyCommand(['check', 'build'])).toBe('npm run check');
  });

  it('joins two or more component scripts (build/lint/typecheck/test) when no direct match exists', () => {
    expect(suggestVerifyCommand(['build', 'test'])).toBe('npm run build && npm run test');
    expect(suggestVerifyCommand(['lint', 'typecheck', 'test'])).toBe(
      'npm run lint && npm run typecheck && npm run test',
    );
  });

  it('returns null when only a single component script is present', () => {
    expect(suggestVerifyCommand(['build'])).toBeNull();
  });

  it('returns null when scripts contain no recognizable candidate', () => {
    expect(suggestVerifyCommand(['start', 'dev'])).toBeNull();
  });
});

describe('buildHarnessContractTicketContent', () => {
  it('returns null for an "ok" contract (nothing to fix)', () => {
    const contract: ContractState = {
      state: 'ok',
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'main',
      models: null,
      expiredExcludeCount: 0,
      modelExclusionWarnings: [],
    };
    expect(buildHarnessContractTicketContent(contract, null)).toBeNull();
  });

  it('returns null for a "not-applicable" contract (not injected)', () => {
    const contract: ContractState = { state: 'not-applicable' };
    expect(buildHarnessContractTicketContent(contract, null)).toBeNull();
  });

  it('builds "missing" content with a verify suggestion when scripts allow one', () => {
    const contract: ContractState = { state: 'missing' };
    const content = buildHarnessContractTicketContent(contract, ['verify', 'build']);
    expect(content).not.toBeNull();
    expect(content?.title).toContain(HARNESS_CONTRACT_RELATIVE_PATH);
    expect(content?.description).toContain('npm run verify');
    expect(content?.description).toContain('"verify": "npm run verify"');
  });

  it('builds "missing" content with a placeholder verify when no suggestion is possible', () => {
    const contract: ContractState = { state: 'missing' };
    const content = buildHarnessContractTicketContent(contract, 'absent');
    expect(content).not.toBeNull();
    expect(content?.description).toContain('推測できませんでした');
    expect(content?.description).toContain('<検証コマンド');
  });

  it('builds "invalid" content that includes the validation message', () => {
    const contract: ContractState = {
      state: 'invalid',
      message: 'verify must be a non-empty string',
    };
    const content = buildHarnessContractTicketContent(contract, null);
    expect(content).not.toBeNull();
    expect(content?.description).toContain('verify must be a non-empty string');
  });

  it('builds "command-missing" content that names the missing npm script', () => {
    const contract: ContractState = {
      state: 'command-missing',
      script: 'verify',
      verify: 'npm run verify',
    };
    const content = buildHarnessContractTicketContent(contract, null);
    expect(content).not.toBeNull();
    expect(content?.description).toContain('"verify"');
    expect(content?.description).toContain('npm run verify');
  });
});

describe('harness contract ticket constants', () => {
  it('uses a fixed label/type/priority for idempotency and classification', () => {
    expect(HARNESS_CONTRACT_TICKET_LABEL).toBe('harness-contract');
    expect(HARNESS_CONTRACT_TICKET_TYPE).toBe('task');
    expect(HARNESS_CONTRACT_TICKET_PRIORITY).toBe(2);
  });
});
