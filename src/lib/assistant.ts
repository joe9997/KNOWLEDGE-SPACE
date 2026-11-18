import { getToken } from './auth';
import type { ApiConfig, KnowledgeDoc } from './types';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface OutgoingChatMessage {
  role: 'user' | 'assistant';
  content: string | ChatContentPart[];
}

const MAX_CONTEXT_CHARS = 6000;
const MAX_NODE_CHARS = 600;

/** 把当前会话整理成轻量上下文，避免把整篇材料塞进对话。 */
export function buildDocContext(doc: KnowledgeDoc | null): string {
  if (!doc) {
    return '';
  }
  const lines = [`会话：${doc.title}`];
  for (const node of doc.nodes) {
    const quote = node.quote.replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_CHARS);
    lines.push(`- ${node.title}${quote ? `：${quote}` : ''}`);
    if (lines.join('\n').length > MAX_CONTEXT_CHARS) {
      break;
    }
  }
  return lines.join('\n').slice(0, MAX_CONTEXT_CHARS);
}

function requestBody(
  messages: OutgoingChatMessage[],
  context: string,
  config?: ApiConfig | null,
) {
  return JSON.stringify({
    messages,
    context,
    ...(config
      ? {
          config: {
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
          },
        }
      : {}),
  });
}

function requestHeaders(): Record<string, string> {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** 调用本地后端的多轮问答接口；传入用户自带配置时优先生效。 */
export async function requestAssistantReply(
  messages: OutgoingChatMessage[],
  context: string,
  config?: ApiConfig | null,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: requestHeaders(),
      body: requestBody(messages, context, config),
    });
  } catch {
    throw new Error('连接不到本地后端，请确认 npm run dev:server 已启动。');
  }

  let data: { reply?: unknown; error?: unknown } = {};
  try {
    data = (await response.json()) as typeof data;
  } catch {
    data = {};
  }
  if (!response.ok) {
    const detail = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (typeof data.reply !== 'string' || !data.reply.trim()) {
    throw new Error('模型返回为空，请稍后再试。');
  }
  return data.reply.trim();
}

/** 流式问答：逐段回调增量文本，返回完整回复。 */
export async function requestAssistantReplyStream(
  messages: OutgoingChatMessage[],
  context: string,
  config: ApiConfig | null | undefined,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: requestHeaders(),
      body: requestBody(messages, context, config),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new Error('连接不到本地后端，请确认 npm run dev:server 已启动。');
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const data = (await response.json()) as { error?: unknown };
      if (typeof data.error === 'string') {
        detail = data.error;
      }
    } catch {
      // 忽略非 JSON 错误体
    }
    throw new Error(detail);
  }
  if (!response.body) {
    throw new Error('浏览器不支持流式响应。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let serverError: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (!payload) {
          continue;
        }
        try {
          const data = JSON.parse(payload) as { delta?: unknown; error?: unknown };
          if (typeof data.delta === 'string' && data.delta) {
            full += data.delta;
            onDelta(data.delta);
          } else if (typeof data.error === 'string') {
            serverError = data.error;
          }
        } catch {
          // 忽略非 JSON 事件
        }
      }
    }
  }

  if (serverError) {
    throw new Error(serverError);
  }
  if (!full.trim()) {
    throw new Error('模型返回为空，请稍后再试。');
  }
  return full.trim();
}
