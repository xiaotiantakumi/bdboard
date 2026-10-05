// `gh api` は -f / -F / --field / --raw-field / --input を 1 つでも付けると、メソッドの
// 既定が GET から POST に切り替わる。-X / --method は最後の値が採られるので、正しい
// `--method GET` の横に別のメソッドを置く形でも POST になる。ヘッダでのメソッド上書き
// (-H X-HTTP-Method-Override) のような禁止リストに載せきれない形もある。
// この reader 群は GitHub へ書き込まないので、組み立てた引数を実行の直前に確かめる:
// 1. 既知の書き込み系の引数を名指しで拒否する (理由が分かるエラーにするため)。
// 2. そのうえで、許可する形ちょうどだけを通す (許可リスト。禁止リストの抜けを塞ぐ)。
// テストでも引数を固定している (三重の備え)。

/** gh api を向けるホスト。継いだ GH_HOST が GHE を指しても github.com で組んだ url と食い違わないよう固定する。 */
export const GH_API_HOSTNAME = 'github.com';

const WRITE_LONG_FLAGS = new Set(['--field', '--raw-field', '--input']);

// repos/<owner>/<repo>/issues?state=open&per_page=<n>&page=<n> だけ。owner と repo は
// parseRepoSlug が通す文字だけで、`.` `..` だけの部分は通さない。
const ISSUES_ENDPOINT =
  /^repos\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/issues\?state=open&per_page=\d{1,3}&page=\d{1,3}$/;

function isWriteFlag(arg: string): boolean {
  if (arg.startsWith('--')) {
    return WRITE_LONG_FLAGS.has(arg.split('=')[0]);
  }
  // 短い形: -f / -F / -X と、付着 (-fkey=value, -XPOST) や束ね (-if) も含める。
  return /^-[A-Za-z]*[fFX]/.test(arg);
}

/** 許可する形: `api --method GET --hostname github.com <endpoint> --jq <jq>` ちょうど。 */
function isAllowedShape(args: readonly string[]): boolean {
  const [api, methodFlag, method, hostFlag, host, endpoint, jqFlag, jq, ...rest] = args;
  return (
    api === 'api' &&
    methodFlag === '--method' &&
    method === 'GET' &&
    hostFlag === '--hostname' &&
    host === GH_API_HOSTNAME &&
    endpoint !== undefined &&
    ISSUES_ENDPOINT.test(endpoint) &&
    jqFlag === '--jq' &&
    jq !== undefined &&
    jq !== '' &&
    rest.length === 0
  );
}

/**
 * `gh api` の引数が読み取り専用の許可する形でなければ Error を投げる。
 * 許可する形は `['api', '--method', 'GET', '--hostname', 'github.com', <endpoint>, '--jq', <jq>]`
 * ちょうど (endpoint は `repos/<owner>/<repo>/issues?state=open&per_page=<n>&page=<n>`)。
 * 書き込み系 (`-f` `-F` `--field` `--raw-field` `--input` とその `=` 形・付着形・束ね形、
 * `-X`、`--method=…`、`--method GET` が 1 回でない) は、理由の分かるエラーで先に拒否する。
 */
export function assertReadOnlyGhApiArgs(args: readonly string[]): void {
  if (args[0] !== 'api') {
    throw new Error('gh api arguments must begin with "api"');
  }
  const writeFlag = args.find(isWriteFlag);
  if (writeFlag !== undefined) {
    throw new Error(`gh api write argument is forbidden: ${writeFlag}`);
  }
  const methodIndexes = args.flatMap((arg, index) => (arg === '--method' ? [index] : []));
  const hasInlineMethod = args.some((arg) => arg.startsWith('--method='));
  if (methodIndexes.length !== 1 || hasInlineMethod || args[methodIndexes[0] + 1] !== 'GET') {
    throw new Error('gh api arguments must contain exactly one "--method GET"');
  }
  if (!isAllowedShape(args)) {
    throw new Error('gh api arguments are not the allowed read-only shape');
  }
}
