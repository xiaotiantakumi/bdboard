import path from 'node:path';

/**
 * scanRoots 設定のサニティ制限(bdboard-bzd)。
 *
 * トンネル書き込み権限があれば PUT /api/settings/scan-roots で `scanRoots: ['/']` を
 * 設定でき、depth 制限があっても全ファイルシステム走査に近い負荷になる。ここでは
 * 「ファイルシステムルートそのもの」と「OS 定番のシステム直下ディレクトリ」を
 * 危険ルートとして拒否する。判定は正規化後の完全一致で行い、システムディレクトリの
 * さらに深い配下(例: /usr/local/foo)は許容する — 目的は事故と嫌がらせの抑止であって
 * パスのアクセス制御ではない。
 *
 * 既知の限界(意図した割り切り):
 * - deep-subpath ポリシーにより /private/etc 等の /private エイリアスは許可される
 *   (macOS では /tmp は /private/tmp の symlink なので、/tmp の拒否は化粧的な意味しかない)。
 * - symlink は解決しない。判定は文字列正規化のみで実ファイルシステムには触れない。
 *   ただし macOS の firmlink `/System/Volumes/Data`(実質 `/` そのもの)だけは
 *   既知の固定パスとして明示的に拒否リストへ載せている。
 *
 * このファイルは scanRoot 危険判定のほか、excludePaths 用の共有ヘルパ
 * stripTrailingSeparators も提供する(bdboard-4iw S4)。
 */

/** POSIX 系(macOS/Linux)で scanRoot として拒否するシステム直下パス。正規化・小文字比較。 */
const DANGEROUS_POSIX_ROOTS: readonly string[] = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/dev',
  '/proc',
  '/sys',
  '/boot',
  '/lib',
  '/lib64',
  '/tmp',
  '/private',
  '/system',
  '/library',
  // macOS のマウント集約点。/mnt・/media と同格で、外付け/ネットワークボリューム全体の走査になる。
  '/volumes',
  // /System/Volumes は Data firmlink を含む実質全 FS ルート(/System/Volumes/Data/.. でも到達可能)。
  '/system/volumes',
  // macOS firmlink: /System/Volumes/Data は実質ルート全体(bdboard-bzd レビュー MF1)
  '/system/volumes/data',
  '/run',
  '/mnt',
  '/media',
  '/srv',
];

/** Windows でドライブ直下にある拒否対象ディレクトリ名。正規化・小文字比較。 */
const DANGEROUS_WINDOWS_DIR_NAMES: readonly string[] = [
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
];

export interface ScanRootsValidation {
  readonly ok: boolean;
  /** 正規化前(ユーザー入力そのまま)の拒否されたパス一覧。ok=true なら空。 */
  readonly rejected: readonly string[];
}

function looksLikeWindowsPath(value: string): boolean {
  // ドライブ相対パス('C:', 'C:.', 'C:foo')も Windows 表記として扱う(SF5)。
  // スラッシュ形 NT 名前空間('//?/'・'//./')も Windows 側へ振り分けて拒否に掛ける(RS2)。
  // '//server/share' 形は含めない: POSIX では先頭 '//' が実装定義ながら合法な通常パスで、
  // POSIX 分岐が '/server/share' へ正規化して通常ルールで扱うため accept のままとする。
  return /^[A-Za-z]:/.test(value) || value.startsWith('\\\\') || /^\/\/[?.]\//.test(value);
}

/**
 * POSIX 絶対('/…')・Windows ドライブ絶対('C:\'/'C:/')・UNC('\\…')のいずれかなら true。
 * 相対パスは readdir が CWD 基準で解決するため、'../../..' 等で実質 FS ルート走査に
 * 到達できる(トンネル経由の直 PUT はクライアント検証を通らない) — bdboard-4iw M1。
 */
function isAbsolutePathLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/**
 * 末尾のパスセパレータを潰す共有ヘルパ(bdboard-4iw S4)。excludePaths の保存時
 * (scan-roots-routes)と消費時(discover-projects / fs-project-discovery)の両方から使い、
 * '/path/' 形エントリの under-exclude を防ぐ。ルート '/' とドライブルート
 * 'C:\'・'C:/' はそれ以上潰さない。
 */
export function stripTrailingSeparators(value: string): string {
  let normalized = value;
  while (
    normalized.length > 1 &&
    /[\\/]$/.test(normalized) &&
    !/^[A-Za-z]:[\\/]$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * 判定用にパスを正規化する。`..`/`.`/連続スラッシュ/末尾スラッシュを潰し、
 * `/etc/`・`//etc`・`/etc/../etc` のような素朴な文字列比較のすり抜けを防ぐ。
 * macOS のファイルシステムは既定で大文字小文字を区別しないため、比較は小文字で行う
 * (Linux で `/ETC` を誤って拒否する分には実害がない)。
 */
function normalizeForPolicy(rawPath: string): {
  readonly value: string;
  readonly isWindows: boolean;
  /** '\\.\' デバイス名前空間や、'\\?\' を剥いた残りがドライブ形にならない特殊 NT パス(S2)。 */
  readonly unsupportedNamespace?: boolean;
} {
  const trimmed = rawPath.trim();
  if (looksLikeWindowsPath(trimmed)) {
    // RS2: スラッシュ形 NT 名前空間('//?/'・'//./')はバックスラッシュ形へ寄せてから
    // 既存のプレフィックス判定に掛ける。
    const prefixCanonical = trimmed.replace(/^\/\/([?.])\//, '\\\\$1\\');
    // S2: '\\.\' デバイス名前空間('\\.\PhysicalDrive0' 等)は scanRoot として意味を成さないため
    // UNC ルール任せにせず明示的に拒否対象へ振り分ける。
    if (/^\\\\\.\\/.test(prefixCanonical)) {
      return { value: prefixCanonical.toLowerCase(), isWindows: true, unsupportedNamespace: true };
    }
    // extended UNC prefix '\\?\UNC\' は通常の UNC 表記に変換してから判定する。
    const withoutExtendedUncPrefix = prefixCanonical.replace(/^\\\\\?\\UNC\\/i, '\\\\');
    // extended-length prefix '\\?\' を外してから判定する(SF5: '\\?\C:\' のすり抜け防止)。
    const withoutExtendedPrefix = withoutExtendedUncPrefix.replace(/^\\\\\?\\/, '');
    // S2: '\\?\' を剥いだ残りがドライブ文字パスでないもの('\\?\Volume{GUID}\'、
    // '\\?\GLOBALROOT\…' 等)は素性不明の NT 名前空間として一律拒否する。
    if (withoutExtendedPrefix !== withoutExtendedUncPrefix && !/^[A-Za-z]:/.test(withoutExtendedPrefix)) {
      return { value: trimmed.toLowerCase(), isWindows: true, unsupportedNamespace: true };
    }
    // 'C:' 単体は win32.normalize が 'C:.'(ドライブ相対カレント)にしてしまうので先に確定させる。
    if (/^[A-Za-z]:$/.test(withoutExtendedPrefix)) {
      return { value: withoutExtendedPrefix.toLowerCase(), isWindows: true };
    }
    let normalized = path.win32.normalize(withoutExtendedPrefix).toLowerCase();
    while (normalized.length > 3 && (normalized.endsWith('\\') || normalized.endsWith('/'))) {
      normalized = normalized.slice(0, -1);
    }
    return { value: normalized, isWindows: true };
  }
  let normalized = path.posix.normalize(trimmed.replaceAll('\\', '/')).toLowerCase();
  normalized = normalized.replace(/^\/+/, '/');
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return { value: normalized, isWindows: false };
}

/**
 * 単一の scanRoot が危険(FS ルートそのもの/既知のシステムディレクトリ/相対パス/
 * 素性不明の NT 名前空間)か判定する。
 */
export function isDangerousScanRoot(rawPath: string): boolean {
  // M1: 絶対パス以外(相対パス・'C:' 等のドライブ相対)は CWD 依存の解決になるため一律拒否。
  if (!isAbsolutePathLike(rawPath.trim())) {
    return true;
  }

  const { value, isWindows, unsupportedNamespace } = normalizeForPolicy(rawPath);
  if (unsupportedNamespace === true) {
    return true;
  }

  if (isWindows) {
    // ドライブルート ('c:' / 'c:\' / 'c:/') そのものは拒否。
    if (/^[a-z]:[\\/]?$/.test(value)) {
      return true;
    }
    // ドライブ相対パス('c:.', 'c:foo')は実行時 CWD を参照するため拒否。生入力の 'C:.' 等は
    // M1 の絶対パス必須チェックで既に落ちるが、'\\?\C:.' のように prefix を剥いだ結果が
    // ドライブ相対へ化ける形をここで塞ぐ。
    if (/^[a-z]:[^\\/]/.test(value)) {
      return true;
    }
    // UNC ルート ('\\server\share' 単体) も拒否。共有直下の全走査を防ぐ。
    // 深い配下 ('\\server\share\folder') は deep-subpath ポリシーに合わせて許容。
    if (/^\\\\[^\\/]+[\\/][^\\/]+$/.test(value)) {
      return true;
    }
    const driveDir = /^[a-z]:[\\/](.+)$/.exec(value);
    if (driveDir?.[1] !== undefined) {
      const firstSegment = driveDir[1].split(/[\\/]/, 1)[0] ?? '';
      return (
        driveDir[1] === firstSegment &&
        DANGEROUS_WINDOWS_DIR_NAMES.includes(firstSegment)
      );
    }
    return false;
  }

  if (value === '/') {
    return true;
  }
  return DANGEROUS_POSIX_ROOTS.includes(value);
}

/** scanRoots の一括検証。拒否対象があれば ok=false と、入力そのままの該当パスを返す。 */
export function validateScanRoots(scanRoots: readonly string[]): ScanRootsValidation {
  const rejected = scanRoots.filter((scanRoot) => isDangerousScanRoot(scanRoot));
  return { ok: rejected.length === 0, rejected };
}
