import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isChatAgentOptedIn, parseChatAgentOptIns } from './chat-agent-gate.js';

describe('parseChatAgentOptIns', () => {
  it('returns an empty set when the env var is unset', () => { expect(parseChatAgentOptIns(undefined)).toEqual(new Set()); });
  it('returns an empty set for an empty string', () => { expect(parseChatAgentOptIns('')).toEqual(new Set()); });
  it('splits on commas and trims whitespace', () => { expect(parseChatAgentOptIns(' codex , cursor ')).toEqual(new Set(['codex', 'cursor'])); });
  it('drops empty entries from stray commas', () => { expect(parseChatAgentOptIns('codex,,cursor,')).toEqual(new Set(['codex', 'cursor'])); });

  describe('normalization and unknown-id warnings (bdboard-l1t.4 SF7)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('lowercases ids so CODEX and codex are treated the same', () => {
      expect(parseChatAgentOptIns('CODEX')).toEqual(new Set(['codex']));
      expect(parseChatAgentOptIns('CoDeX, Codex')).toEqual(new Set(['codex']));
    });

    it('does not warn for the known codex id', () => {
      parseChatAgentOptIns('codex');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn for the known agy id (bdboard-l1t.6)', () => {
      parseChatAgentOptIns('agy');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns once per unknown id', () => {
      parseChatAgentOptIns('codex,typo-agent');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('typo-agent');
    });
  });
});
describe('isChatAgentOptedIn', () => {
  it('is false when BDBOARD_CHAT_AGENTS is unset (codex not registered by default)', () => { expect(isChatAgentOptedIn('codex', parseChatAgentOptIns(undefined))).toBe(false); });
  it('is true when the agent id is present in the opt-in list', () => { expect(isChatAgentOptedIn('codex', parseChatAgentOptIns('codex'))).toBe(true); });
  it('is false for an agent id not present in the opt-in list', () => { expect(isChatAgentOptedIn('codex', parseChatAgentOptIns('cursor'))).toBe(false); });
});
