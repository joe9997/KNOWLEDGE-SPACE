export type ThemeMode = 'dark' | 'light';

export type AppView = 'home' | 'new' | 'graph' | 'review' | 'settings' | 'assistant';

/** 图谱呈现方式；venn 为不同的集合重叠视图 */
export type GraphView = 'galaxy' | 'radial' | 'tree' | 'timeline' | 'venn';

export type Mastery = 0 | 1 | 2;

/** 复习状态：到期 / 模糊 / 已掌握 */
export type NodeStatus = 'due' | 'fuzzy' | 'mastered';

export type DocOrigin = 'demo' | 'local' | 'ai';

export interface KnowledgeNode {
  id: string;
  title: string;
  question: string;
  /** 原文引用。必须逐字来自 KnowledgeDoc.text，否则视为无出处 */
  quote: string;
  /** 匹配到的原文字符起点，-1 表示未匹配（无出处） */
  quoteStart: number;
  quoteEnd: number;
  parentId: string | null;
  level: number;
  mastery: Mastery;
  goodStreak: number;
  lastReviewedAt: number | null;
  /** 毫秒时间戳 */
  nextReviewAt: number;
}

export interface Relation {
  from: string;
  to: string;
}

/** 用户在原文里划出的一段批注 */
export interface SourceAnnotation {
  id: string;
  /** 原文起始字符位置（含） */
  start: number;
  /** 原文结束字符位置（不含） */
  end: number;
  /** 划选的原文，便于离线展示与校验 */
  quote: string;
  note: string;
  createdAt: number;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  text: string;
  origin: DocOrigin;
  createdAt: number;
  updatedAt: number;
  nodes: KnowledgeNode[];
  relations: Relation[];
  /** 原文批注；旧数据可能没有该字段 */
  annotations?: SourceAnnotation[];
}

export interface ApiConfig {
  /** 模型服务标识，例如 openai / deepseek / custom */
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ReviewGrade = 0 | 1 | 2;

export interface User {
  id: string;
  email: string;
  username: string;
  avatar: string | null;
  hasPassword: boolean;
  hasPasskey: boolean;
  createdAt: number;
}

export interface ExtractedNode {
  title: string;
  quote: string;
  question: string;
  level: number;
}

export interface GraphPosition {
  x: number;
  y: number;
}

export interface QuizQueueItem {
  nodeId: string;
}
