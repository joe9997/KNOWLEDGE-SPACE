import type { KnowledgeNode, Mastery, NodeStatus, ReviewGrade } from './types';

export const DAY_MS = 86_400_000;

export interface ReviewSchedule {
  mastery: Mastery;
  goodStreak: number;
  /** 间隔天数，用于 UI 文案 */
  intervalDays: number;
  nextReviewAt: number;
}

export interface ReviewOptions {
  /** 掌握后的基础记忆天数，默认 3 */
  baseDays?: number;
  /** 学习节奏系数：冲刺 < 1，深耕 > 1 */
  rhythmFactor?: number;
}

/**
 * 简化 SM-2（PRD 第 11 节），基础间隔可被个性化偏好调整：
 * grade 0 → mastery 0, streak 0, +max(1, round(baseDays * 0.35 * factor)) 天
 * grade 1 → mastery 1, streak 0, +max(1, round(baseDays * 0.6 * factor)) 天
 * grade 2 → mastery 2, streak +1, +round(baseDays * 1.6^streak * factor) 天
 * 默认 baseDays=3、factor=1 时与原算法完全一致（1 / 2 / 5 / 8 / 12 天）。
 */
export function scheduleReview(
  current: { goodStreak: number },
  grade: ReviewGrade,
  now: number,
  options: ReviewOptions = {},
): ReviewSchedule {
  const baseDays = Math.min(30, Math.max(1, options.baseDays ?? 3));
  const factor = Math.min(3, Math.max(0.2, options.rhythmFactor ?? 1));
  if (grade === 0) {
    const intervalDays = Math.max(1, Math.round(baseDays * 0.35 * factor));
    return { mastery: 0, goodStreak: 0, intervalDays, nextReviewAt: now + DAY_MS * intervalDays };
  }
  if (grade === 1) {
    const intervalDays = Math.max(1, Math.round(baseDays * 0.6 * factor));
    return { mastery: 1, goodStreak: 0, intervalDays, nextReviewAt: now + DAY_MS * intervalDays };
  }
  const goodStreak = current.goodStreak + 1;
  const intervalDays = Math.max(1, Math.round(baseDays * Math.pow(1.6, goodStreak) * factor));
  return {
    mastery: 2,
    goodStreak,
    intervalDays,
    nextReviewAt: now + DAY_MS * intervalDays,
  };
}

/** 是否已到期 / 过期 */
export function isDue(nextReviewAt: number, now: number): boolean {
  return nextReviewAt <= now;
}

/**
 * 是否临近到期（剩余 ≤ windowDays 天）。默认窗口 3 天。
 * 用于"黄色"状态：时间充裕(scheduled) → 临近(soon) → 过期(due)。
 */
export function isSoon(nextReviewAt: number, now: number, windowDays = 3): boolean {
  if (isDue(nextReviewAt, now)) return false;
  const diffDays = (nextReviewAt - now) / DAY_MS;
  return diffDays <= windowDays;
}

/** 距下次复习还剩多少天（向上取整，负数表示已过期多少天） */
export function daysUntil(nextReviewAt: number, now: number): number {
  return Math.ceil((nextReviewAt - now) / DAY_MS);
}

/**
 * 三档动态状态：按"剩余天数 + 掌握程度"决定颜色。
 *   'due'       已过期 → 红
 *   'soon'      剩余 1-3 天 → 黄
 *   'scheduled' 剩余 4+ 天 → 绿
 *   'mastered'  mastery=2 → 完成灰
 *   'fuzzy'     兜底（旧数据没 nextReviewAt）
 */
export function statusOf(
  node: { mastery: Mastery; nextReviewAt: number },
  now: number,
): NodeStatus {
  if (isDue(node.nextReviewAt, now)) {
    return 'due';
  }
  if (node.mastery === 2) {
    return 'mastered';
  }
  if (isSoon(node.nextReviewAt, now, 3)) {
    return 'soon';
  }
  // 有明确 nextReviewAt 且还远 → 已安排
  if (Number.isFinite(node.nextReviewAt) && node.nextReviewAt > 0) {
    return 'scheduled';
  }
  return 'fuzzy';
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  due: '已过期',
  soon: '临近复习',
  scheduled: '已安排',
  fuzzy: '模糊',
  mastered: '已掌握',
};

export const GRADE_LABEL: Record<ReviewGrade, string> = {
  0: '还没记住',
  1: '有点模糊',
  2: '已经掌握',
};

export function formatRelativeDue(nextReviewAt: number, now: number): string {
  const diff = nextReviewAt - now;
  if (diff <= 0) {
    const overDays = Math.ceil(-diff / DAY_MS);
    return overDays <= 1 ? '今天到期' : `已过期 ${overDays} 天`;
  }
  const days = Math.ceil(diff / DAY_MS);
  if (days <= 1) {
    return '今天稍后';
  }
  return `${days} 天后`;
}

/** 跨所有 docs 收集今日该复习的节点，按紧急度（过期优先 → 临近优先）排序 */
export function collectDueNodesFromDocs(
  docs: Array<{ id: string; nodes: Array<KnowledgeNode> }>,
  now: number,
): Array<{ docId: string; docTitle: string; node: KnowledgeNode }> {
  const out: Array<{ docId: string; docTitle: string; node: KnowledgeNode }> = [];
  for (const doc of docs) {
    for (const node of doc.nodes) {
      if (node.mastery === 2) continue;
      if (isDue(node.nextReviewAt, now) || isSoon(node.nextReviewAt, now, 3)) {
        out.push({ docId: doc.id, docTitle: (doc as { title?: string }).title ?? doc.id, node });
      }
    }
  }
  out.sort((a, b) => {
    // 过期优先（越小越靠前），然后临近
    return a.node.nextReviewAt - b.node.nextReviewAt;
  });
  return out;
}
