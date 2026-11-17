import type { ApiConfig, ExtractedNode } from './types';
import { findQuote } from './quotes';

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;
const MAX_CHUNKS = 26;

export interface ApiValidation {
  ok: boolean;
  errors: Partial<Record<keyof ApiConfig, string>>;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function validateApiConfig(config: ApiConfig): ApiValidation {
  const errors: ApiValidation['errors'] = {};
  if (!config.apiKey.trim()) {
    errors.apiKey = '请填写 API Key';
  }
  if (!config.model.trim()) {
    errors.model = '请填写模型名称';
  }
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) {
    errors.baseUrl = '请填写接口 Base URL';
  } else if (!/^https?:\/\/[^\s]+$/i.test(base)) {
    errors.baseUrl = 'Base URL 需以 http:// 或 https:// 开头';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

function requestError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new Error('请求超时，请检查网络或接口地址。');
  }
  if (error instanceof TypeError) {
    return new Error(
      '请求未能完成：可能是网络不可达，或该模型服务不允许浏览器跨域（CORS）调用。',
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function readError(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = await response.text();
    detail = body.slice(0, 240).replace(/\s+/g, ' ');
  } catch {
    detail = '';
  }
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${
    detail ? ` · ${detail}` : ''
  }`;
}

export async function testConnection(
  config: ApiConfig,
): Promise<{ count: number | null; message: string }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20000);
  try {
    const base = normalizeBaseUrl(config.baseUrl);
    const response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey.trim()}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`连接失败 · ${await readError(response)}`);
    }
    let data: { data?: unknown };
    try {
      data = (await response.json()) as { data?: unknown };
    } catch {
      throw new Error(
        '接口返回 200，但不是 JSON。请确认 Base URL 指向 OpenAI 兼容服务（通常以 /v1 结尾）。',
      );
    }
    if (!Array.isArray(data.data)) {
      throw new Error('接口返回 200，但没有可识别的模型列表 data[]，无法确认连接可用。');
    }
    const count = data.data.length;
    return {
      count,
      message: `连接成功：/models 返回 ${count} 个可用模型。`,
    };
  } catch (error) {
    throw requestError(error);
  } finally {
    window.clearTimeout(timer);
  }
}

export function chunkText(
  text: string,
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): Array<{ text: string; start: number }> {
  const chunks: Array<{ text: string; start: number }> = [];
  let start = 0;
  while (start < text.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(text.length, start + size);
    chunks.push({ text: text.slice(start, end), start });
    if (end >= text.length) {
      break;
    }
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

const PROMPT = `你是知识结构化助手。把用户提供的内容整理成带原文引用的层级大纲。

输出格式（严格遵守，只输出这些行，不要解释、不要代码块包裹）：
# 中心主题
## 节点标题 :: 原文中的一整句 :: 一个回忆问句
### 子节点标题 :: 原文中的一整句 :: 问句

硬性要求：
1. 用 # 的数量表示层级，最多 4 层。
2. 每行用 " :: " 分为三段：标题、原句引用、回忆问句。
3. 「原句引用」必须逐字摘自用户原文，不得改写、不得拼接两句。
4. 找不到可引用的原句时，该段写 "-"，不要编造。
5. 同级节点不超过 7 个，标题不超过 20 字。
6. 只使用原文出现的概念，不引入外部知识。
7. 问句要能单独回答，针对标题提问，不超过 30 字。

原文：
`;

/** 解析 Markdown 层级输出。逐行容错，坏行只跳过，不丢整棵树。 */
export function parseExtraction(content: string): ExtractedNode[] {
  const lines = content.replace(/```[a-zA-Z]*/g, '').split(/\r?\n/);
  const nodes: ExtractedNode[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('```')) {
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (!heading) {
      continue;
    }
    const level = heading[1].length - 1;
    const body = heading[2];
    const parts = body.split(/\s*::\s*/);
    const title = (parts[0] ?? '').trim().replace(/^[*_`]+|[*_`]+$/g, '').slice(0, 20);
    if (!title) {
      continue;
    }
    const quoteRaw = (parts[1] ?? '').trim().replace(/^["“「']+|["”」']+$/g, '');
    // 中心主题行可以没有引用；此时用标题去原文中做逐字校验，匹配不到仍然是「无出处」
    const quote = parts.length < 2 ? title : quoteRaw === '-' ? '' : quoteRaw;
    const question = (parts[2] ?? '').trim() || `「${title}」的要点是什么？`;
    nodes.push({ title, quote, question, level: Math.min(3, level) });
  }
  return nodes;
}

function mergeExtractions(chunks: ExtractedNode[][], text: string): ExtractedNode[] {
  const merged: ExtractedNode[] = [];
  const seen = new Map<string, number>();
  for (const nodes of chunks) {
    for (const node of nodes) {
      const key = node.title.replace(/\s+/g, '').toLowerCase();
      if (seen.has(key)) {
        const index = seen.get(key)!;
        const existing = merged[index];
        if (!findQuote(text, existing.quote).matched && findQuote(text, node.quote).matched) {
          merged[index] = { ...existing, quote: node.quote };
        }
        continue;
      }
      seen.set(key, merged.length);
      merged.push({ ...node });
    }
  }
  // 跨 chunk 合并后只保留一个中心节点，其余同级根节点下沉一层
  merged.forEach((node, index) => {
    if (index > 0 && node.level === 0) {
      merged[index] = { ...node, level: 1 };
    }
  });
  return merged.slice(0, 40);
}

export interface ExtractionProgress {
  done: number;
  total: number;
}

export async function extractWithAI(
  config: ApiConfig,
  text: string,
  onProgress?: (progress: ExtractionProgress) => void,
  signal?: AbortSignal,
): Promise<ExtractedNode[]> {
  const validation = validateApiConfig(config);
  if (!validation.ok) {
    throw new Error('API 配置不完整，请补全后再试。');
  }
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error('材料为空，无法抽取。');
  }

  const results: ExtractedNode[][] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    onProgress?.({ done: i, total: chunks.length });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 90000);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const base = normalizeBaseUrl(config.baseUrl);
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: config.model.trim(),
          temperature: 0.2,
          stream: false,
          messages: [
            {
              role: 'system',
              content: '你只输出符合约定的 Markdown 大纲，不输出解释或代码块。',
            },
            { role: 'user', content: `${PROMPT}${chunks[i].text}` },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`模型调用失败 · ${await readError(response)}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('模型返回为空或格式不可识别。');
      }
      results.push(parseExtraction(content));
      onProgress?.({ done: i + 1, total: chunks.length });
    } catch (error) {
      throw requestError(error);
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const merged = mergeExtractions(results, text);
  if (merged.length === 0) {
    throw new Error('模型没有返回可解析的节点，请检查模型是否遵循 Markdown 输出格式。');
  }
  return merged;
}
