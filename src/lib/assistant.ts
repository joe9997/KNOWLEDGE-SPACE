import type { KnowledgeDoc } from './types';

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

/** 调用本地后端的多轮问答接口。 */
export async function requestAssistantReply(
  messages: OutgoingChatMessage[],
  context: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, context }),
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
