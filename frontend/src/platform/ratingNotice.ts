/**
 * 把服务器下发的「本局计不计分」预判翻成玩家看得懂的一句话（规格 4.2 的开局前提示）。
 *
 * 为什么要单开一个纯函数：文案与 reason 的映射必须被单测钉住。
 * 这一条规格此前只做了后半句（真的不计分），前半句「**且开局前提示**」没人做，
 * 玩家是打完之后才发现分数没动 —— 现在在开局时就把话说明白。
 */
import type { RatingPreviewWire } from '../ws';

/** 计分预判 -> 提示文案；本局计分或没有预判时返回 null（不显示任何东西）。 */
export function ratingNoticeOf(preview?: RatingPreviewWire | null): string | null {
  if (!preview || preview.ranked !== false) return null;
  switch (preview.reason) {
    case 'REPEAT_OPPONENTS':
      return '你们三人在 24 小时内已经下满 3 局，本局不计竞技分。';
    case 'NOT_THREE_HUMANS':
      return '本局有 AI 补位，不计竞技分。';
    case 'NOT_TUTORIAL_COMPLETE':
      return '有玩家还没完成教学（或还是临时账号），本局不计竞技分。';
    case 'NOT_ONLINE_MODE':
      return '好友对弈不计竞技分。';
    default:
      return '本局不计竞技分。';
  }
}
