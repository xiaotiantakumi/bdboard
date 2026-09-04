import { compareStrings } from './compare.js';

export const MINIMUM_CLAUDE_VERSION = '2.1.233';

export type ClaudeVersionStatus = 'supported' | 'too-old' | 'unknown';

export interface ClaudeVersionCheck {
  readonly status: ClaudeVersionStatus;
  readonly version: string | null;
  readonly message: string;
}

const SEMVER_PATTERN = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

export function parseClaudeVersion(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  const match = SEMVER_PATTERN.exec(trimmed);
  if (match === null) {
    return null;
  }

  const [, major, minor, patch, prerelease] = match;
  if (prerelease !== undefined) {
    return `${major}.${minor}.${patch}-${prerelease}`;
  }

  return `${major}.${minor}.${patch}`;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseVersionParts(version: string): ParsedVersion {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) {
    const [core, ...prereleaseParts] = version.split('-');
    const parts = core.split('.');
    return {
      major: Number(parts[0]) || 0,
      minor: Number(parts[1]) || 0,
      patch: Number(parts[2]) || 0,
      prerelease: prereleaseParts.length > 0 ? prereleaseParts.join('-') : null,
    };
  }

  return {
    major: Number(match[1]) || 0,
    minor: Number(match[2]) || 0,
    patch: Number(match[3]) || 0,
    prerelease: match[4] ?? null,
  };
}

function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const maxLen = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLen; i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];

    if (aPart === undefined) {
      return -1;
    }
    if (bPart === undefined) {
      return 1;
    }

    const aNum = /^\d+$/.test(aPart) ? Number(aPart) : null;
    const bNum = /^\d+$/.test(bPart) ? Number(bPart) : null;

    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) {
        return aNum - bNum;
      }
      continue;
    }

    if (aNum !== null && bNum === null) {
      return -1;
    }
    if (aNum === null && bNum !== null) {
      return 1;
    }

    // Semver prerelease identifiers compare in ASCII order; localeCompare would
    // vary by environment and break ordering.
    const cmp = compareStrings(aPart, bPart);
    if (cmp !== 0) {
      return cmp;
    }
  }

  return 0;
}

export function compareClaudeVersions(a: string, b: string): number {
  const parsedA = parseVersionParts(a);
  const parsedB = parseVersionParts(b);

  if (parsedA.major !== parsedB.major) {
    return parsedA.major - parsedB.major;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor - parsedB.minor;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch - parsedB.patch;
  }

  if (parsedA.prerelease === null && parsedB.prerelease === null) {
    return 0;
  }
  if (parsedA.prerelease === null) {
    return 1;
  }
  if (parsedB.prerelease === null) {
    return -1;
  }

  return comparePrereleaseIdentifiers(parsedA.prerelease, parsedB.prerelease);
}

/**
 * infrastructure 層が取得した claude CLI のバージョンを、agent-run が要求する最低版と比較する。
 *
 * unknown では run を弾かない。BDBOARD_CLAUDE_PATH がラッパースクリプトを指している
 * 正当な構成では `claude --version` が semver を返さないことがあり、そこを fail-closed
 * すると agent-run 全体が無言で死ぬため。一次の保険は起動前の `claude --version`
 * による事前チェック (本関数)。二次の保険は describeClaudeSettingSourcesFailure()
 * による stderr 翻訳だが、文字列マッチは脆いので単独では使わない。
 */
export function evaluateClaudeVersion(
  rawVersionOutput: string | null,
  minimum = MINIMUM_CLAUDE_VERSION,
): ClaudeVersionCheck {
  const version = parseClaudeVersion(rawVersionOutput);

  if (version === null) {
    return {
      status: 'unknown',
      version: null,
      message: `claude CLI version could not be determined; agent runs require ${minimum} or newer (the run passes --setting-sources, which older CLIs reject).`,
    };
  }

  if (compareClaudeVersions(version, minimum) < 0) {
    return {
      status: 'too-old',
      version,
      message:
        `claude CLI is too old for agent runs: found ${version}, but ${minimum} or newer is required. ` +
        'The run passes --setting-sources, which older CLIs reject as an unknown option. ' +
        'Upgrade the claude CLI (or point BDBOARD_CLAUDE_PATH at a newer one).',
    };
  }

  return {
    status: 'supported',
    version,
    message: `claude CLI version ${version} meets the minimum ${minimum} for agent runs.`,
  };
}

/**
 * spawn 失敗や非ゼロ終了時の stderr から、古い CLI が --setting-sources を拒否した
 * 兆候を読み取る二次の保険。事前の `claude --version` チェックが一次。
 *
 * 文字列マッチは脆いので、これ単独をバージョン検出の手段にはしない。
 */
export function describeClaudeSettingSourcesFailure(
  stderr: string | null | undefined,
): string | null {
  if (stderr === null || stderr === undefined || stderr.trim() === '') {
    return null;
  }

  const lower = stderr.toLowerCase();
  if (!lower.includes('setting-sources')) {
    return null;
  }

  const hasUnknownOptionSignal =
    lower.includes('unknown option') ||
    lower.includes('unrecognized option') ||
    lower.includes('unknown argument') ||
    lower.includes('error: unknown');

  if (!hasUnknownOptionSignal) {
    return null;
  }

  return (
    `claude CLI is too old for agent runs: ${MINIMUM_CLAUDE_VERSION} or newer is required. ` +
    'The run passes --setting-sources, which older CLIs reject as an unknown option. ' +
    'Upgrade the claude CLI (or point BDBOARD_CLAUDE_PATH at a newer one).'
  );
}
