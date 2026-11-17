import type { Mastery, NodeStatus, ReviewGrade } from './types';

export const DAY_MS = 86_400_000;

export interface ReviewSchedule {
  mastery: Mastery;
  goodStreak: number;
  /** 间隔天数，用于 UI 文案 */
  intervalDays: number;
  nextReviewAt: number;
}

/**
 * 简化 SM-2（PRD 第 11 节）：
 * grade 0 → mastery 0, streak 0, +1 天
 * grade 1 → mastery 1, streak 0, +2 天
 * grade 2 → mastery 2, streak +1, +round(3 * 1.6^streak) 天
 */
export function scheduleReview(
  current: { goodStreak: number },
  grade: ReviewGrade,
  now: number,
): ReviewSchedule {
  if (grade === 0) {
    return { mastery: 0, goodStreak: 0, intervalDays: 1, nextReviewAt: now + DAY_MS };
  }
  if (grade === 1) {
    return { mastery: 1, goodStreak: 0, intervalDays: 2, nextReviewAt: now + DAY_MS * 2 };
  }
  const goodStreak = current.goodStreak + 1;
  const intervalDays = Math.round(3 * Math.pow(1.6, goodStreak));
  return {
    mastery: 2,
    goodStreak,
    intervalDays,
    nextReviewAt: now + DAY_MS * intervalDays,
  };
}

export function isDue(nextReviewAt: number, now: number): boolean {
  return nextReviewAt <= now;
}

export function statusOf(
  node: { mastery: Mastery; nextReviewAt: number },
  now: number,
): NodeStatus {
  if (isDue(node.nextReviewAt, now)) {
    return 'due';
  }
  return node.mastery === 2 ? 'mastered' : 'fuzzy';
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  due: '待复习',
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
    return '已到期';
  }
  const days = Math.ceil(diff / DAY_MS);
  if (days <= 1) {
    return '今天稍后';
  }
  return `${days} 天后`;
}
