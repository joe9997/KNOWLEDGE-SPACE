import type { ApiConfig, ExtractedNode } from './types';
import {
  chunkText,
  mergeExtractions,
  PROMPT,
  parseExtraction,
  SYSTEM_PROMPT,
} from './extractCore';

export { chunkText, parseExtraction } from './extractCore';

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
            { role: 'system', content: SYSTEM_PROMPT },
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
