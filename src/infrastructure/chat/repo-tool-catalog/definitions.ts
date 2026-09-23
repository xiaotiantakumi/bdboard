import type { BdToolDefinition } from '../bd-tool-catalog.js';

/**
 * bdboard-sso1.71: repo-tool-catalog.ts のモジュール分割で切り出した、ツール名の
 * allowlist とツール定義本体。バレルは ../repo-tool-catalog.ts。
 */

export const REPO_TOOL_NAMES = ['repo_ticket_landed', 'repo_path_exists'] as const;
export type RepoToolName = (typeof REPO_TOOL_NAMES)[number];

export function isRepoToolName(toolName: string): toolName is RepoToolName {
  return (REPO_TOOL_NAMES as readonly string[]).includes(toolName);
}

export const REPO_TOOL_DEFINITIONS: readonly BdToolDefinition[] = [
  {
    name: 'repo_ticket_landed',
    description:
      'チケットIDを含むコミットが対象ref(既定 origin/main)にあるかを調べる(読み取り専用)',
    writes: false,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ticketId'],
      properties: {
        ticketId: {
          type: 'string',
          description: 'チケットID',
        },
        ref: {
          type: 'string',
          description: '対象ref(既定: origin/main)',
        },
      },
    },
  },
  {
    name: 'repo_path_exists',
    description:
      '対象ref(既定 origin/main)にその文字列を含むパスが残っているかを調べる(読み取り専用)',
    writes: false,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: {
          type: 'string',
          description: 'パスに含まれる文字列(大文字小文字を区別しない、1..200文字)',
        },
        ref: {
          type: 'string',
          description: '対象ref(既定: origin/main)',
        },
      },
    },
  },
] as const;
