import type { GraphView, Mastery } from './types';

export type PaletteTheme = 'nebula' | 'aurora' | 'sakura' | 'solar';

/** 学习节奏：决定同样的评级下，多久后再次安排复习 */
export type StudyRhythm = 'sprint' | 'steady' | 'deep';

/** 打开题库时默认进入的学习方式 */
export type QuizDefault = 'ask' | 'choice' | 'self';

export interface LearningPrefs {
  /** 星球配色方案 */
  palette: PaletteTheme;
  /** 学习节奏 */
  rhythm: StudyRhythm;
  /** 掌握后的基础记忆天数，1–14 */
  baseDays: number;
  /** 题库默认方式 */
  quizMode: QuizDefault;
  /** 打开图谱时默认使用的呈现方式 */
  graphView: GraphView;
}

export interface PaletteThemeOption {
  id: PaletteTheme;
  label: string;
  hint: string;
  /** 三个掌握度档位的 HSL 基础值：没记住 / 有点模糊 / 已掌握 */
  hues: Record<Mastery, [number, number, number]>;
}

export const PALETTE_THEMES: PaletteThemeOption[] = [
  {
    id: 'nebula',
    label: '星云',
    hint: '玫红 · 琥珀 · 薄荷，默认的星系配色',
    hues: { 0: [338, 84, 66], 1: [34, 92, 58], 2: [164, 76, 55] },
  },
  {
    id: 'aurora',
    label: '极光',
    hint: '花粉 · 紫罗兰 · 湖青，像高纬夜空',
    hues: { 0: [322, 82, 67], 1: [266, 72, 66], 2: [178, 80, 52] },
  },
  {
    id: 'sakura',
    label: '樱雪',
    hint: '淡粉 · 薰衣草 · 青瓷，柔和低饱和',
    hues: { 0: [350, 74, 71], 1: [300, 54, 69], 2: [172, 46, 59] },
  },
  {
    id: 'solar',
    label: '日冕',
    hint: '朱红 · 鎏金 · 湖蓝，对比更强',
    hues: { 0: [8, 84, 64], 1: [38, 94, 57], 2: [192, 84, 50] },
  },
];

export const RHYTHM_OPTIONS: Array<{ id: StudyRhythm; label: string; hint: string; factor: number }> = [
  { id: 'sprint', label: '冲刺', hint: '间隔更短，适合考前密集复习', factor: 0.6 },
  { id: 'steady', label: '稳步', hint: '默认节奏，兼顾记忆与负担', factor: 1 },
  { id: 'deep', label: '深耕', hint: '间隔更长，适合长期记忆', factor: 1.45 },
];

export const QUIZ_OPTIONS: Array<{ id: QuizDefault; label: string; hint: string }> = [
  { id: 'ask', label: '每次询问', hint: '打开题库时先选方式' },
  { id: 'choice', label: '自动选择题', hint: '直接判分，快速过一遍' },
  { id: 'self', label: '问答自评', hint: '先回忆，再对照原文' },
];

export const GRAPH_VIEW_OPTIONS: Array<{ id: GraphView; label: string; hint: string }> = [
  { id: 'galaxy', label: '星系图', hint: '默认视图，拖动可旋转整个星盘' },
  { id: 'radial', label: '辐射图', hint: '从中心向外按层级展开' },
  { id: 'tree', label: '树形图', hint: '从左到右阅读大纲结构' },
  { id: 'timeline', label: '时间线', hint: '按最近复习时间排列节点' },
  { id: 'venn', label: '韦恩图', hint: '用重叠的集合看一级主题与交集' },
];

export const DEFAULT_PREFS: LearningPrefs = {
  palette: 'nebula',
  rhythm: 'steady',
  baseDays: 3,
  quizMode: 'ask',
  graphView: 'galaxy',
};

export const MIN_BASE_DAYS = 1;
export const MAX_BASE_DAYS = 14;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function rhythmFactor(rhythm: StudyRhythm): number {
  return RHYTHM_OPTIONS.find((option) => option.id === rhythm)?.factor ?? 1;
}

export function themeHues(theme: PaletteTheme): Record<Mastery, [number, number, number]> {
  return (
    PALETTE_THEMES.find((option) => option.id === theme) ?? PALETTE_THEMES[0]
  ).hues;
}

function hslChannels(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((channel) => Math.round((channel + m) * 255)) as [number, number, number];
}

function toHex(channels: [number, number, number]): string {
  return `#${channels
    .map((channel) => clamp(channel, 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * 同一掌握度下生成三档星光，按节点 id 稳定分配，
 * 让星系有层次但不破坏图例语义。浅色主题整体压暗，保证在雾蓝背景上可读。
 */
export function paletteVariant(
  theme: PaletteTheme,
  mastery: Mastery,
  light: boolean,
  index = 1,
): { core: string; mid: string; halo: string } {
  const [baseH, baseS, baseL] = themeHues(theme)[mastery];
  const hueShift = [-9, 0, 11][clamp(index, 0, 2)];
  const lightShift = [-2, 0, 4][clamp(index, 0, 2)];
  const h = baseH + hueShift;
  const s = clamp(baseS + (light ? 4 : 0) - (index === 2 ? 4 : 0), 20, 96);
  const l = clamp(baseL + lightShift + (light ? -18 : 0), 28, 82);
  const core = hslChannels(h, s, l);
  const mid = hslChannels(h, clamp(s - 14, 15, 96), clamp(l + (light ? 15 : 18), 38, 94));
  return {
    core: toHex(core),
    mid: toHex(mid),
    halo: core.join(', '),
  };
}

/** 按当前主题解析配色：浅色主题自动使用更深的同一色系 */
export function resolvePaletteColor(
  theme: PaletteTheme,
  mastery: Mastery,
  light: boolean,
  index = 1,
): { core: string; mid: string; halo: string } {
  return paletteVariant(theme, mastery, light, index);
}

export function normalizePrefs(value: unknown): LearningPrefs {
  if (!value || typeof value !== 'object') {
    return DEFAULT_PREFS;
  }
  const raw = value as Partial<LearningPrefs>;
  const palette = PALETTE_THEMES.some((option) => option.id === raw.palette)
    ? (raw.palette as PaletteTheme)
    : DEFAULT_PREFS.palette;
  const rhythm = RHYTHM_OPTIONS.some((option) => option.id === raw.rhythm)
    ? (raw.rhythm as StudyRhythm)
    : DEFAULT_PREFS.rhythm;
  const quizMode = QUIZ_OPTIONS.some((option) => option.id === raw.quizMode)
    ? (raw.quizMode as QuizDefault)
    : DEFAULT_PREFS.quizMode;
  const graphView = GRAPH_VIEW_OPTIONS.some((option) => option.id === raw.graphView)
    ? (raw.graphView as GraphView)
    : DEFAULT_PREFS.graphView;
  const baseDaysValue = Number(raw.baseDays);
  return {
    palette,
    rhythm,
    quizMode,
    graphView,
    baseDays: Number.isFinite(baseDaysValue)
      ? clamp(Math.round(baseDaysValue), MIN_BASE_DAYS, MAX_BASE_DAYS)
      : DEFAULT_PREFS.baseDays,
  };
}
