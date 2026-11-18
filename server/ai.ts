import type { ExtractedNode } from '../src/lib/types.ts';
import { PROMPT, SYSTEM_PROMPT, parseExtraction } from '../src/lib/extractCore.ts';
import type { AiConfig } from './config.ts';

const TEST_TIMEOUT_MS = 20_000;

export interface TestResult {
  count: number;
  message: string;
}

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export interface ChatImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type ChatContent = string | Array<ChatTextPart | ChatImagePart>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

function requestError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error('请求超时，请检查网络或模型服务地址。');
  }
  if (error instanceof TypeError) {
    return new Error('无法连接模型服务：请检查网络、LLM_BASE_URL 是否正确。');
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function readDetail(response: Response): Promise<string> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300).replace(/\s+/g, ' ');
  } catch {
    detail = '';
  }
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${
    detail ? ` · ${detail}` : ''
  }`;
}

/** GET /models：只有 200 且返回 data[] 才算连接可用，不伪造成功。 */
export async function testConnection(config: AiConfig): Promise<TestResult> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw requestError(error);
  }
  if (!response.ok) {
    throw new Error(`连接失败 · ${await readDetail(response)}`);
  }
  let data: { data?: unknown };
  try {
    data = (await response.json()) as { data?: unknown };
  } catch {
    throw new Error('模型服务返回 200，但不是 JSON。请确认 Base URL 指向 OpenAI 兼容服务（通常以 /v1 结尾）。');
  }
  if (!Array.isArray(data.data)) {
    throw new Error('模型服务返回 200，但没有可识别的模型列表 data[]，无法确认连接可用。');
  }
  return {
    count: data.data.length,
    message: `连接成功：${config.model} 所在服务 /models 返回 ${data.data.length} 个可用模型。`,
  };
}

/** 多轮问答：把消息原样转发给 OpenAI 兼容接口，返回纯文本回复。 */
export async function chat(
  config: AiConfig,
  messages: ChatMessage[],
  timeoutMs: number,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.5,
        stream: false,
        messages,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw requestError(error);
  }
  if (!response.ok) {
    throw new Error(`模型调用失败 · ${await readDetail(response)}`);
  }
  let data: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    throw new Error('模型返回的不是 JSON，无法解析。');
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('模型返回为空或格式不可识别。');
  }
  return content.trim();
}

/** 对单个文本块调用模型并解析成节点；失败时抛出带真实原因的 Error。 */
export async function extractChunk(
  config: AiConfig,
  text: string,
  timeoutMs: number,
): Promise<ExtractedNode[]> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${PROMPT}${text}` },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw requestError(error);
  }
  if (!response.ok) {
    throw new Error(`模型调用失败 · ${await readDetail(response)}`);
  }
  let data: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    throw new Error('模型返回的不是 JSON，无法解析。');
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('模型返回为空或格式不可识别。');
  }
  const nodes = parseExtraction(content);
  if (nodes.length === 0) {
    throw new Error('模型没有返回可解析的节点，请检查模型是否遵循 Markdown 输出格式。');
  }
  return nodes;
}
