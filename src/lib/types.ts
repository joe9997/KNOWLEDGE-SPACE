export type ThemeMode = 'dark' | 'light';

export type AppView = 'home' | 'new' | 'graph' | 'api';

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

export interface KnowledgeDoc {
  id: string;
  title: string;
  text: string;
  origin: DocOrigin;
  createdAt: number;
  updatedAt: number;
  nodes: KnowledgeNode[];
  relations: Relation[];
}

export interface ApiConfig {
  /** 模型服务标识，例如 openai / deepseek / custom */
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ReviewGrade = 0 | 1 | 2;

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
