import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  PALETTE_THEMES,
  normalizePrefs,
  paletteVariant,
  rhythmFactor,
} from '../learningPrefs';
import type { Mastery } from '../types';

describe('个性化学习偏好', () => {
  it('缺省与非法输入回落到默认值，并夹紧记忆天数', () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({ palette: 'unknown', rhythm: 'x', quizMode: 'y', baseDays: 99 })).toEqual({
      ...DEFAULT_PREFS,
      baseDays: 14,
    });
    expect(normalizePrefs({ palette: 'sakura', rhythm: 'sprint', quizMode: 'self', baseDays: 0 })).toEqual({
      palette: 'sakura',
      rhythm: 'sprint',
      quizMode: 'self',
      graphView: 'galaxy',
      baseDays: 1,
    });
  });

  it('三种掌握度在每个配色方案中都能区分，浅色主题整体更深', () => {
    for (const theme of PALETTE_THEMES) {
      const cores = ([0, 1, 2] as Mastery[]).map((mastery) => paletteVariant(theme.id, mastery, false).core);
      expect(new Set(cores).size).toBe(3);
      const dark = paletteVariant(theme.id, 2, false, 1).core;
      const light = paletteVariant(theme.id, 2, true, 1).core;
      expect(light).not.toBe(dark);
      expect(paletteVariant(theme.id, 2, true, 1)).toEqual(paletteVariant(theme.id, 2, true, 1));
    }
  });

  it('节奏系数按冲刺、稳步、深耕递增', () => {
    expect(rhythmFactor('sprint')).toBeLessThan(rhythmFactor('steady'));
    expect(rhythmFactor('deep')).toBeGreaterThan(rhythmFactor('steady'));
  });
});
