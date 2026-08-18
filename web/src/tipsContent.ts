import { HELP_SECTIONS } from './helpContent';

/**
 * ボード上のTipsはヘルプ本文を原本にする。ヘルプを更新すれば、Tipsも同じ説明に追随する。
 */
export const TIPS = HELP_SECTIONS.map(({ id, title, description }) => ({
  helpSectionId: id,
  title,
  text: description,
}));

export type Tip = (typeof TIPS)[number];
