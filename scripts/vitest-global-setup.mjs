// bdboard-72oy: vitest の globalSetup (vitest.config.ts / web/vitest.config.ts)。何があっても投げない
// (読み込みに失敗しても単発実行を止めないよう、ロジックは try の中で動的 import する)。
export default async function setup(project) {
  try {
    // verify の中 (フラグは scripts/verify-slot.mjs の IN_VERIFY_ENV。名前が揃うことはテストが固定している) では、
    // ロジックのモジュール群を読み込まずに戻る。中でももう一度確かめる (checkOutsideVerify)。
    if (process.env.BDBOARD_IN_VERIFY === '1') {
      return;
    }
    const { checkOutsideVerify } = await import('./vitest-outside-verify.mjs');
    await checkOutsideVerify({ context: { root: project && project.config && project.config.root } });
  } catch {
    // bdboard-72oy: 診断処理の失敗でテスト実行を止めない。
  }
}
