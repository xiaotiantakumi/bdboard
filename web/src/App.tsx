import { AppBody } from './components/app/AppBody';
import { useAppController } from './components/app/useAppController';

/**
 * App.tsx はこれまで一連の move-only 抽出(#546, #654, #659, #666, #672)で
 * 1200行 → 422行(ESLint実測)まで削減した後、今回の段(bdboard-62p4 第6段)で
 * さらに構造を変えた: 全hook呼び出しを useAppController.ts(controller)へ、
 * JSX本体を AppBody.tsx(表示専用)へ抽出し、TicketDetailPanel
 * (bdboard-sso1.5)と同じ「controller hook + presentational body」構成にした。
 * useHeaderHeightVar の呼び出しは useAppController の先頭に移した
 * (useAppController.ts の JSDoc 参照)。
 */
export function App() {
  const controller = useAppController();
  return <AppBody controller={controller} />;
}
