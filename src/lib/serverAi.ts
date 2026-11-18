import { apiFetch } from './auth';
import type { ExtractedNode } from './types';
import { chunkText, mergeExtractions } from './extractCore';
import type { ExtractionProgress } from './llm';

export interface ServerAiStatus {
  reachable: boolean;
  available: boolean;
  model: string | null;
  baseUrl: string | null;
}

async function readApiError(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === 'string') {
      detail = body.error;
    }
  } catch {
    detail = '';
  }
  if (!detail) {
    try {
      detail = (await response.text()).slice(0, 240).replace(/\s+/g, ' ');
    } catch {
      detail = '';
    }
  }
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${
    detail ? ` · ${detail}` : ''
  }`;
}

function networkError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error('请求已取消或超时。');
  }
  if (error instanceof TypeError) {
    return new Error('无法连接后端服务，请确认已运行 npm run dev:server。');
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function getServerAiStatus(): Promise<ServerAiStatus> {
  const response = await apiFetch('/api/ai/status');
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  const data = (await response.json()) as Partial<ServerAiStatus>;
  return {
    reachable: true,
    available: data.available === true,
    model: typeof data.model === 'string' ? data.model : null,
    baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl : null,
  };
}

export async function testServerConnection(): Promise<{ count: number; message: string }> {
  let response: Response;
  try {
    response = await apiFetch('/api/ai/test', { method: 'POST' });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) {
    throw new Error(`连接失败 · ${await readApiError(response)}`);
  }
  return (await response.json()) as { count: number; message: string };
}

export async function extractWithServer(
  text: string,
  onProgress?: (progress: ExtractionProgress) => void,
  signal?: AbortSignal,
): Promise<ExtractedNode[]> {
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error('材料为空，无法抽取。');
  }

  const results: ExtractedNode[][] = [];
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      onProgress?.({ done: i, total: chunks.length });
      const response = await apiFetch('/api/ai/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: chunks[i].text }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`模型调用失败 · ${await readApiError(response)}`);
      }
      const data = (await response.json()) as { nodes?: unknown };
      if (!Array.isArray(data.nodes)) {
        throw new Error('后端返回的节点格式不可识别。');
      }
      results.push(data.nodes as ExtractedNode[]);
      onProgress?.({ done: i + 1, total: chunks.length });
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw networkError(error);
  }

  const merged = mergeExtractions(results, text);
  if (merged.length === 0) {
    throw new Error('模型没有返回可解析的节点，请检查模型是否遵循 Markdown 输出格式。');
  }
  return merged;
}
