// bdboard-72oy: vitest の globalSetup (vitest.config.ts / web/vitest.config.ts)。何があっても投げない
// (読み込みに失敗しても単発実行を止めないよう、ロジックは try の中で動的 import する)。
export default async function setup(project) {
  try {
    const { checkOutsideVerify } = await import('./vitest-outside-verify.mjs');
    await checkOutsideVerify({ context: { root: project && project.config && project.config.root } });
  } catch {
    // bdboard-72oy: 診断処理の失敗でテスト実行を止めない。
  }
}
