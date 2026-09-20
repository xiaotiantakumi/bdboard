// bd-tool-catalog.ts (bdboard-sso1.18) の分割の合成層。read-tools.ts / lifecycle-tools.ts /
// content-tools.ts / schedule-label-tools.ts / create-dep-tools.ts の5モジュールから、
// 各ツールの定義 (定数) と builder 関数を取りまとめ、分割前と同じ公開エクスポート面
// (BdToolDefinition / BD_TOOL_DEFINITIONS / BdArgsBuildResult / buildBdToolArgs) を
// 再現する。
//
// BD_TOOL_DEFINITIONS は AI へ渡るプロンプトの一部であり、配列の並び順と各要素の
// name/description/inputSchema が1文字でも変わるとモデルの挙動が変わりうるため、
// 分割前の元ファイル (bd-tool-catalog.ts) の宣言順をそのままここに列挙して再現している
// (どのファイルに定義が住んでいるかと、最終的な配列の並び順は独立 — bd_search は
// read-tools.ts に住むが、元の並びでは bd_create の直後に来る)。
// bd-tool-catalog.catalogSnapshot.test.ts が sha256 でこの不変条件を固定する。
export type { BdToolDefinition, BdArgsBuildResult } from './types.js';

import type { BdArgsBuildResult, BdToolDefinition } from './types.js';
import { reject } from './args-helpers.js';
import {
  bdListTool,
  bdReadyTool,
  bdBlockedTool,
  bdShowTool,
  bdSearchTool,
  buildReadToolArgs,
} from './read-tools.js';
import {
  bdUpdateStatusTool,
  bdClaimTool,
  bdCloseTool,
  buildLifecycleToolArgs,
} from './lifecycle-tools.js';
import {
  bdUpdateTitleTool,
  bdUpdateDescriptionTool,
  bdAppendNotesTool,
  bdCommentTool,
  buildContentToolArgs,
} from './content-tools.js';
import {
  bdDeferTool,
  bdPriorityTool,
  bdLabelAddTool,
  bdLabelRemoveTool,
  buildScheduleLabelToolArgs,
} from './schedule-label-tools.js';
import {
  bdCreateTool,
  bdDepAddTool,
  bdDepRemoveTool,
  buildCreateDepToolArgs,
} from './create-dep-tools.js';

export const BD_TOOL_DEFINITIONS: readonly BdToolDefinition[] = [
  bdListTool,
  bdReadyTool,
  bdBlockedTool,
  bdShowTool,
  bdUpdateStatusTool,
  bdUpdateTitleTool,
  bdUpdateDescriptionTool,
  bdAppendNotesTool,
  bdClaimTool,
  bdCloseTool,
  bdCommentTool,
  bdDeferTool,
  bdPriorityTool,
  bdLabelAddTool,
  bdLabelRemoveTool,
  bdCreateTool,
  bdSearchTool,
  bdDepAddTool,
  bdDepRemoveTool,
] as const;

export function buildBdToolArgs(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): BdArgsBuildResult {
  return (
    buildReadToolArgs(toolName, rawArgs, projectRootPath) ??
    buildLifecycleToolArgs(toolName, rawArgs, projectRootPath) ??
    buildContentToolArgs(toolName, rawArgs, projectRootPath) ??
    buildScheduleLabelToolArgs(toolName, rawArgs, projectRootPath) ??
    buildCreateDepToolArgs(toolName, rawArgs, projectRootPath) ??
    reject(`unknown tool: ${toolName}`)
  );
}
