import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { readServerConfig } from './config';
import { chat, extractChunk, testConnection } from './ai';
import type { ChatContent, ChatMessage } from './ai';
import { readSnapshot, sanitizeDocs, writeSnapshot } from './store';

const MAX_CHUNK_CHARS = 4000;
const MAX_CHAT_CONTEXT = 8000;
const MAX_CHAT_MESSAGES = 24;
const MAX_CHAT_TEXT = 12000;

function sanitizeChatContent(raw: unknown): ChatContent | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? text.slice(0, MAX_CHAT_TEXT) : null;
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const parts: Exclude<ChatContent, string> = [];
  for (const part of raw.slice(0, 6)) {
    const text = typeof part?.text === 'string' ? part.text.trim() : '';
    const url = part?.image_url?.url;
    if (part?.type === 'text' && text) {
      parts.push({ type: 'text', text: text.slice(0, MAX_CHAT_TEXT) });
    } else if (
      part?.type === 'image_url' &&
      typeof url === 'string' &&
      /^data:image\/(png|jpe?g|webp);base64,/i.test(url)
    ) {
      parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return parts.length > 0 ? parts : null;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = readServerConfig();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'knowledge-space-api',
    ai: {
      available: Boolean(config.ai),
      model: config.ai?.model ?? null,
    },
  });
});

app.get('/api/data', async (_req, res) => {
  const snapshot = await readSnapshot();
  res.json(snapshot);
});

app.put('/api/data', async (req, res) => {
  const docs = sanitizeDocs(req.body?.docs);
  if (!docs) {
    res.status(400).json({ error: 'docs 必须是数组。' });
    return;
  }
  const activeDocId =
    typeof req.body?.activeDocId === 'string' ? req.body.activeDocId : null;
  const snapshot = { docs, activeDocId, updatedAt: Date.now() };
  await writeSnapshot(snapshot);
  console.log(`[store] 已保存 ${docs.length} 个会话`);
  res.json({ ok: true, updatedAt: snapshot.updatedAt });
});

app.get('/api/ai/status', (_req, res) => {  res.json({
    available: Boolean(config.ai),
    model: config.ai?.model ?? null,
    baseUrl: config.ai?.baseUrl ?? null,
  });
});

app.post('/api/ai/test', async (_req: Request, res: Response) => {
  if (!config.ai) {
    res.status(503).json({ error: '服务端未配置 LLM_API_KEY，请在 .env 中填写后重启服务。' });
    return;
  }
  try {
    const result = await testConnection(config.ai);
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/ai/chat', async (req: Request, res: Response) => {
  if (!config.ai) {
    res.status(503).json({ error: '服务端未配置 LLM_API_KEY，请在 .env 中填写后重启服务。' });
    return;
  }
  const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages: ChatMessage[] = [];
  for (const item of rawMessages.slice(-MAX_CHAT_MESSAGES)) {
    const role = item?.role;
    const content = sanitizeChatContent(item?.content);
    if ((role === 'user' || role === 'assistant') && content) {
      messages.push({ role, content });
    }
  }
  if (messages.length === 0 || messages[messages.length - 1]?.role !== 'user') {
    res.status(400).json({ error: '请求缺少有效的 user 消息。' });
    return;
  }
  const context =
    typeof req.body?.context === 'string' ? req.body.context.slice(0, MAX_CHAT_CONTEXT) : '';
  const system: ChatMessage = {
    role: 'system',
    content: [
      '你是「回源」的知识学习助手，帮助用户理解当前会话中的材料。',
      '回答要简洁、具体，优先使用当前材料中的概念；材料没有覆盖的内容要明确说明，不要编造。',
      context ? `当前会话材料：\n${context}` : '当前没有打开具体会话，可做通用学习答疑。',
    ].join('\n'),
  };
  try {
    const reply = await chat(config.ai, [system, ...messages], config.extractTimeoutMs);
    console.log(`[ai] chat ok · ${messages.length} 条消息`);
    res.json({ reply });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ai] chat failed · ${message}`);
    res.status(502).json({ error: message });
  }
});

app.post('/api/ai/extract', async (req: Request, res: Response) => {
  if (!config.ai) {
    res.status(503).json({ error: '服务端未配置 LLM_API_KEY，请在 .env 中填写后重启服务。' });
    return;
  }
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    res.status(400).json({ error: '请求缺少 text 字段。' });
    return;
  }
  if (text.length > MAX_CHUNK_CHARS) {
    res.status(400).json({ error: `单个文本块不能超过 ${MAX_CHUNK_CHARS} 字。` });
    return;
  }
  try {
    const nodes = await extractChunk(config.ai, text, config.extractTimeoutMs);
    console.log(`[ai] extract ok · ${text.length} 字 · ${nodes.length} 个节点`);
    res.json({ nodes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ai] extract failed · ${message}`);
    res.status(502).json({ error: message });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在。' });
});

// 构建产物存在时顺带托管前端，便于 npm run build && npm start 单进程运行
const distDir = path.join(rootDir, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    return;
  }
  const status = (error as { status?: number }).status ?? 500;
  const message = error instanceof Error ? error.message : '服务端未知错误。';
  res.status(status).json({ error: message });
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[api] http://127.0.0.1:${config.port}`);
  console.log(
    config.ai
      ? `[ai] 已配置 · ${config.ai.model} · ${config.ai.baseUrl}`
      : '[ai] 未配置 · 复制 .env.example 为 .env 并填写 LLM_API_KEY',
  );
});
