import { DEFAULT_PREFS, normalizePrefs } from './learningPrefs';
import type { LearningPrefs } from './learningPrefs';
import type { KnowledgeDoc, ThemeMode } from './types';

const DOCS_KEY = 'huiyuan.docs.v1';
const ACTIVE_KEY = 'huiyuan.activeDoc.v1';
const THEME_KEY = 'huiyuan.theme';
const API_KEY = 'huiyuan.api.session.v1';
const PREFS_KEY = 'huiyuan.learning.v1';

function docsKey(userId: string): string {
  return `${DOCS_KEY}.${userId}`;
}

function activeKey(userId: string): string {
  return `${ACTIVE_KEY}.${userId}`;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadDocs(userId: string): KnowledgeDoc[] | null {
  const parsed = safeParse<KnowledgeDoc[]>(localStorage.getItem(docsKey(userId)));
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.filter(
    (doc) =>
      doc &&
      typeof doc.id === 'string' &&
      typeof doc.title === 'string' &&
      typeof doc.text === 'string' &&
      Array.isArray(doc.nodes),
  );
}

export function saveDocs(userId: string, docs: KnowledgeDoc[]): void {
  try {
    localStorage.setItem(docsKey(userId), JSON.stringify(docs));
  } catch (error) {
    console.warn('保存文档失败', error);
  }
}

export function loadActiveDocId(userId: string): string | null {
  return localStorage.getItem(activeKey(userId));
}

export function saveActiveDocId(userId: string, id: string | null): void {
  if (id) {
    localStorage.setItem(activeKey(userId), id);
  } else {
    localStorage.removeItem(activeKey(userId));
  }
}

export function loadTheme(): ThemeMode {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

export function saveTheme(theme: ThemeMode): void {
  localStorage.setItem(THEME_KEY, theme);
}

function prefsKey(userId: string): string {
  return `${PREFS_KEY}.${userId}`;
}

export function loadLearningPrefs(userId: string): LearningPrefs {
  return normalizePrefs(safeParse<unknown>(localStorage.getItem(prefsKey(userId)))) ?? DEFAULT_PREFS;
}

export function saveLearningPrefs(userId: string, prefs: LearningPrefs): void {
  try {
    localStorage.setItem(prefsKey(userId), JSON.stringify(prefs));
  } catch (error) {
    console.warn('保存学习偏好失败', error);
  }
}

/** API 配置按用户隔离（BYOK 的 key 只在当前标签页 sessionStorage，刷新即失效） */
function apiConfigKey(userId: string): string {
  return `${API_KEY}.${userId}`;
}

export function loadApiConfig(userId: string): import('./types').ApiConfig | null {
  const parsed = safeParse<import('./types').ApiConfig>(sessionStorage.getItem(apiConfigKey(userId)));
  if (!parsed || typeof parsed.apiKey !== 'string' || typeof parsed.baseUrl !== 'string') {
    return null;
  }
  return parsed;
}

export function saveApiConfig(userId: string, config: import('./types').ApiConfig): void {
  sessionStorage.setItem(apiConfigKey(userId), JSON.stringify(config));
}

export function clearApiConfig(userId: string): void {
  sessionStorage.removeItem(apiConfigKey(userId));
}
