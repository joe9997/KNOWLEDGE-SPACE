import { apiFetch } from './auth';
import type { ChoiceQuestion } from './quizBank';
import type { ApiConfig, KnowledgeDoc } from './types';

const CACHE_PREFIX = 'ks.quiz.cache.v1';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** 缓存键只依赖节点内容，不依赖 updatedAt，避免答完一题就失效 */
function cacheKeyOf(
  doc: KnowledgeDoc,
  nodes: Array<{ id: string; title: string; quote: string }>,
  userId?: string,
): string {
  const signature = nodes
    .map((node) => `${node.id}:${node.title}:${node.quote.slice(0, 80)}`)
    .join('|');
  return `${CACHE_PREFIX}:${userId ?? 'anon'}:${doc.id}:${hashString(signature)}`;
}

function readCache(key: string): ChoiceQuestion[] | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { at?: unknown; questions?: unknown };
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > CACHE_TTL) {
      window.localStorage.removeItem(key);
      return null;
    }
    return Array.isArray(parsed.questions) ? (parsed.questions as ChoiceQuestion[]) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, questions: ChoiceQuestion[]): void {
  if (questions.length === 0) {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), questions }));
  } catch {
    // 本地存储已满时放弃缓存，不影响本次出题
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === 'string') {
      return body.error;
    }
  } catch {
    // 忽略非 JSON 错误体
  }
  return `HTTP ${response.status}`;
}

/**
 * 让模型根据知识点和原文引用直接出选择题。
 * 只发送标题与引用，不发送整篇材料，避免题目脱离知识点。
 */
export async function requestAiQuiz(
  doc: KnowledgeDoc,
  nodeIds: string[],
  config: ApiConfig | null,
  userId?: string,
  signal?: AbortSignal,
): Promise<ChoiceQuestion[]> {
  const seen = new Set<string>();
  const nodes = nodeIds
    .map((id) => doc.nodes.find((node) => node.id === id))
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .filter((node) => {
      if (seen.has(node.id) || !node.quote.trim()) {
        return false;
      }
      seen.add(node.id);
      return true;
    })
    .slice(0, 12)
    .map((node) => ({
      id: node.id,
      title: node.title,
      quote: node.quote.replace(/\s+/g, ' ').trim().slice(0, 240),
    }));
  if (nodes.length === 0) {
    return [];
  }

  const cacheKey = cacheKeyOf(doc, nodes, userId);
  const cached = readCache(cacheKey);
  if (cached && cached.length > 0) {
    return cached;
  }

  const response = await apiFetch('/api/ai/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodes,
      text: doc.text.slice(0, 1200),
      ...(config ? { config } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const data = (await response.json()) as { questions?: unknown };
  const questions = Array.isArray(data.questions)
    ? (data.questions as ChoiceQuestion[])
    : [];
  writeCache(cacheKey, questions);
  return questions;
}
