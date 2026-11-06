// bdboard-l1m1.14: 設定画面のパック一覧の「外す」案内 (HarnessPacksSection から分離。
// ファイル行数の上限のため)。サーバーはパックを外さない — scripts/harness-uninject.mjs を
// ユーザーが自分の端末で実行するための、コピーできるコマンドを順番に出すだけ。
import type { ProjectHarnessPackStatusDto } from '../../api';
import {
  buildHarnessUninjectCommand,
  buildHarnessUninjectYesCommand,
  HARNESS_BASE_UNINJECT_CAUTION,
  HARNESS_UNINJECT_ROOT_PLACEHOLDER,
} from '../../harnessPackSelection';
import { useAutoClearedValue } from '../../hooks/useAutoClearedValue';
import { copyText, COPY_FEEDBACK_MS } from '../ticket-detail/TicketIdCopyButton';

function UninjectCommandRow({
  step,
  command,
  copyLabel,
}: {
  readonly step: string;
  readonly command: string;
  readonly copyLabel: string;
}) {
  const { value: copyState, show } = useAutoClearedValue<'' | 'copied' | 'error'>(
    '',
    COPY_FEEDBACK_MS,
  );

  return (
    <div className="harness-pack-uninject-step">
      <span className="harness-pack-uninject-step-label">{step}</span>
      <div className="harness-pack-uninject-row">
        <code className="harness-pack-uninject-command">{command}</code>
        <button
          type="button"
          className="harness-pack-action"
          aria-label={copyLabel}
          onClick={() => {
            void copyText(command).then((ok) => {
              show(ok ? 'copied' : 'error');
            });
          }}
        >
          コピー
        </button>
        <span aria-live="polite" className="harness-pack-copy-feedback">
          {copyState === 'copied' && 'コピーしました'}
          {copyState === 'error' && 'コピーできませんでした'}
        </span>
      </div>
    </div>
  );
}

/**
 * 「外す」の案内。実行は bdboard ではなくユーザー自身が、scripts/harness-uninject.mjs で行う。
 * 順序は 1) dry-run で何が消えるかを確認、2) 問題なければ Claude Code の外の自分の端末で --yes。
 */
export function UninjectCommand({
  projectRootPath,
  bdboardRootPath,
  pack,
}: {
  readonly projectRootPath: string;
  readonly bdboardRootPath: string | undefined;
  readonly pack: ProjectHarnessPackStatusDto;
}) {
  const dryRunCommand = buildHarnessUninjectCommand(projectRootPath, pack.name, bdboardRootPath);
  const yesCommand = buildHarnessUninjectYesCommand(projectRootPath, pack.name, bdboardRootPath);
  const hasRoot = bdboardRootPath !== undefined && bdboardRootPath.length > 0;

  return (
    <details className="harness-pack-uninject">
      <summary aria-label={`${pack.name} を外す手順を開く`}>外す</summary>
      <p className="settings-panel-subtitle">
        bdboard はパックを外しません。次の順にコマンドを実行してください。まず 1 で何が消えるかを確認し
        (何も変更しません)、問題なければ 2 を、Claude Code の外のあなた自身の端末で実行します。
        エージェントには実行させないでください。
      </p>
      {pack.role === 'base' && (
        <p className="harness-pack-uninject-caution" role="note">
          {HARNESS_BASE_UNINJECT_CAUTION}
        </p>
      )}
      {!hasRoot && (
        <p className="settings-panel-subtitle">
          {HARNESS_UNINJECT_ROOT_PLACEHOLDER} は、この bdboard をチェックアウトしているフォルダの
          パスに置き換えてください。
        </p>
      )}
      <div className="harness-pack-uninject-steps">
        <UninjectCommandRow
          step="1. 確認 (dry-run。何も変更しません)"
          command={dryRunCommand}
          copyLabel={`${pack.name} を外す前の確認コマンド (dry-run) をコピー`}
        />
        <UninjectCommandRow
          step="2. 外す (--yes。自分の端末で実行)"
          command={yesCommand}
          copyLabel={`${pack.name} を外すコマンド (--yes) をコピー`}
        />
      </div>
    </details>
  );
}
