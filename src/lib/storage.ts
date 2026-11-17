import type { KnowledgeDoc, ThemeMode } from './types';

const DOCS_KEY = 'huiyuan.docs.v1';
const ACTIVE_KEY = 'huiyuan.activeDoc.v1';
const THEME_KEY = 'huiyuan.theme';
const API_KEY = 'huiyuan.api.session.v1';

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

export function loadDocs(): KnowledgeDoc[] | null {
  const parsed = safeParse<KnowledgeDoc[]>(localStorage.getItem(DOCS_KEY));
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

export function saveDocs(docs: KnowledgeDoc[]): void {
  try {
    localStorage.setItem(DOCS_KEY, JSON.stringify(docs));
  } catch (error) {
    console.warn('保存文档失败', error);
  }
}

export function loadActiveDocId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveDocId(id: string | null): void {
  if (id) {
    localStorage.setItem(ACTIVE_KEY, id);
  } else {
    localStorage.removeItem(ACTIVE_KEY);
  }
}

export function loadTheme(): ThemeMode {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

export function saveTheme(theme: ThemeMode): void {
  localStorage.setItem(THEME_KEY, theme);
}

/** API 配置只允许存在 sessionStorage，刷新标签页即失效；绝不写入 localStorage */
export function loadApiConfig(): import('./types').ApiConfig | null {
  const parsed = safeParse<import('./types').ApiConfig>(sessionStorage.getItem(API_KEY));
  if (!parsed || typeof parsed.apiKey !== 'string' || typeof parsed.baseUrl !== 'string') {
    return null;
  }
  return parsed;
}

export function saveApiConfig(config: import('./types').ApiConfig): void {
  sessionStorage.setItem(API_KEY, JSON.stringify(config));
}

export function clearApiConfig(): void {
  sessionStorage.removeItem(API_KEY);
}
