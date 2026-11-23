import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  formatRelativeDue,
  isDue,
  scheduleReview,
  statusOf,
} from '../review';
import { createDemoDoc } from '../../data/demo';

const NOW = new Date('2026-11-17T09:00:00+08:00').getTime();

describe('简化 SM-2 复习算法', () => {
  it('grade 0：回到 1 天后，掌握度归零', () => {
    const result = scheduleReview({ goodStreak: 3 }, 0, NOW);
    expect(result.mastery).toBe(0);
    expect(result.goodStreak).toBe(0);
    expect(result.intervalDays).toBe(1);
    expect(result.nextReviewAt).toBe(NOW + DAY_MS);
  });

  it('grade 1：2 天后复习，连续正确清零', () => {
    const result = scheduleReview({ goodStreak: 5 }, 1, NOW);
    expect(result.mastery).toBe(1);
    expect(result.goodStreak).toBe(0);
    expect(result.intervalDays).toBe(2);
    expect(result.nextReviewAt).toBe(NOW + 2 * DAY_MS);
  });

  it('grade 2：连续正确时按 3 * 1.6^streak 递增', () => {
    const first = scheduleReview({ goodStreak: 0 }, 2, NOW);
    const second = scheduleReview({ goodStreak: 1 }, 2, NOW);
    const third = scheduleReview({ goodStreak: 2 }, 2, NOW);
    expect(first).toMatchObject({ mastery: 2, goodStreak: 1, intervalDays: 5 });
    expect(second).toMatchObject({ mastery: 2, goodStreak: 2, intervalDays: 8 });
    expect(third).toMatchObject({ mastery: 2, goodStreak: 3, intervalDays: 12 });
    expect(third.nextReviewAt).toBe(NOW + 12 * DAY_MS);
  });

  it('个性化记忆天数与节奏会缩放复习间隔', () => {
    const longMemory = scheduleReview({ goodStreak: 0 }, 2, NOW, { baseDays: 7 });
    expect(longMemory.intervalDays).toBe(11);

    const sprint = scheduleReview({ goodStreak: 0 }, 2, NOW, {
      baseDays: 3,
      rhythmFactor: 0.6,
    });
    expect(sprint.intervalDays).toBe(3);

    const quickFail = scheduleReview({ goodStreak: 4 }, 0, NOW, { baseDays: 1 });
    expect(quickFail.intervalDays).toBe(1);
    expect(quickFail.goodStreak).toBe(0);
  });

  it('到期判断与状态颜色映射', () => {
    expect(isDue(NOW - 1, NOW)).toBe(true);
    expect(isDue(NOW + 1, NOW)).toBe(false);
    expect(statusOf({ mastery: 0, nextReviewAt: NOW - 1 }, NOW)).toBe('due');
    // 剩余 1 天 → soon（黄）
    expect(statusOf({ mastery: 1, nextReviewAt: NOW + DAY_MS }, NOW)).toBe('soon');
    // 剩余 5 天 → scheduled（绿）
    expect(statusOf({ mastery: 1, nextReviewAt: NOW + 5 * DAY_MS }, NOW)).toBe('scheduled');
    expect(statusOf({ mastery: 2, nextReviewAt: NOW + DAY_MS }, NOW)).toBe('mastered');
  });

  it('相对时间文案', () => {
    // 刚过期 5ms → 今天到期
    expect(formatRelativeDue(NOW - 5, NOW)).toBe('今天到期');
    expect(formatRelativeDue(NOW + Math.ceil(DAY_MS * 3.2), NOW)).toBe('4 天后');
  });
});

describe('示例材料与时间旅行', () => {
  it('示例包含 12+ 个节点，且每个引用都逐字可溯源', () => {
    const doc = createDemoDoc(NOW);
    expect(doc.nodes.length).toBeGreaterThanOrEqual(12);
    doc.nodes.forEach((node) => {
      expect(node.quoteStart).toBeGreaterThanOrEqual(0);
      expect(doc.text.slice(node.quoteStart, node.quoteEnd)).toBe(node.quote);
    });
  });

  it('今天恰有 3 个到期节点，三天后到期数增加', () => {
    const doc = createDemoDoc(NOW);
    const dueToday = doc.nodes.filter((node) => isDue(node.nextReviewAt, NOW)).length;
    const dueInThreeDays = doc.nodes.filter((node) =>
      isDue(node.nextReviewAt, NOW + 3 * DAY_MS),
    ).length;
    const dueInSevenDays = doc.nodes.filter((node) =>
      isDue(node.nextReviewAt, NOW + 7 * DAY_MS),
    ).length;
    expect(dueToday).toBe(3);
    expect(dueInThreeDays).toBeGreaterThan(dueToday);
    expect(dueInSevenDays).toBeGreaterThan(dueInThreeDays);
  });
});
