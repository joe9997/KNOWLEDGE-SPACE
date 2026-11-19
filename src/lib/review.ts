import type { Mastery, NodeStatus, ReviewGrade } from './types';

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
