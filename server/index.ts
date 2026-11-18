import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { readServerConfig } from './config.ts';
import type { AiConfig } from './config.ts';
import { chat, chatStream, extractChunk, testConnection } from './ai.ts';
import type { ChatContent, ChatMessage } from './ai.ts';
import {
  changePassword,
  deleteSession,
  loginWithPassword,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  registerUser,
  removePasskey,
  resolveSession,
  toPublicUser,
  updateProfile,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from './auth.ts';
import type { UserRecord } from './auth.ts';
import { rateLimit } from './ratelimit.ts';
import { readSnapshot, sanitizeDocs, validateDocsPayload, writeSnapshot } from './store.ts';

const MAX_CHUNK_CHARS = 4000;
const MAX_CHAT_CONTEXT = 8000;
const MAX_CHAT_MESSAGES = 24;
const MAX_CHAT_TEXT = 40000;

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

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface AuthedRequest extends Request {
  auth?: { user: UserRecord; token: string };
}

function webAuthnContext(req: Request): { rpID: string; origin: string } {
  const origin = req.get('origin') ?? 'http://localhost:5173';
  let rpID = 'localhost';
  try {
    rpID = new URL(origin).hostname;
  } catch {
    rpID = 'localhost';
  }
  return { rpID, origin };
}

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  const user = await resolveSession(token);
  if (!user) {
    res.status(401).json({ error: '登录已过期，请重新登录' });
    return;
  }
  req.auth = { user, token };
  next();
}

/** 把认证业务抛出的 Error 统一映射为 400；存储类错误保留 503，细节只进日志 */
function asAuth(handler: (req: AuthedRequest, res: Response) => Promise<unknown>) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status && status >= 500) {
        console.error(`[auth] ${error instanceof Error ? error.message : String(error)}`);
        next(new HttpError(status, '服务暂时不可用，请稍后重试。'));
        return;
      }
      next(new HttpError(400, error instanceof Error ? error.message : String(error)));
    }
  };
}

app.disable('x-powered-by');
// Vercel / 反向代理后面才能拿到真实客户端 IP，否则限流会把所有人算成同一个 IP
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));

// ---------- 限流（进程内计数，单实例有效；多实例需换 Redis） ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: '登录尝试过于频繁，请 15 分钟后再试。',
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: '注册过于频繁，请稍后再试。',
});
const passkeyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: 'passkey 请求过于频繁，请稍后再试。',
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  key: (req) => (req as AuthedRequest).auth?.user.id ?? req.ip ?? 'unknown',
  message: '模型调用过于频繁，请稍后再试。',
});

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

// ---------- 认证 ----------
app.post(
  '/api/auth/register',
  registerLimiter,
  asAuth(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    res.json(await registerUser({ email, username, password }));
  }),
);

app.post(
  '/api/auth/login',
  loginLimiter,
  asAuth(async (req, res) => {
    const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    res.json(await loginWithPassword(identifier, password));
  }),
);

app.post('/api/auth/logout', requireAuth, async (req: AuthedRequest, res: Response) => {
  await deleteSession(req.auth!.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res: Response) => {
  res.json({ user: toPublicUser(req.auth!.user) });
});

app.put(
  '/api/auth/profile',
  requireAuth,
  asAuth(async (req, res) => {
    const user = await updateProfile(req.auth!.user.id, {
      username: typeof req.body?.username === 'string' ? req.body.username : undefined,
      email: typeof req.body?.email === 'string' ? req.body.email : undefined,
      avatar: req.body?.avatar !== undefined ? req.body.avatar : undefined,
    });
    res.json({ user });
  }),
);

app.post(
  '/api/auth/password',
  requireAuth,
  asAuth(async (req, res) => {
    const currentPassword =
      typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    await changePassword(req.auth!.user.id, currentPassword, newPassword, req.auth!.token);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/auth/passkey/register-options',
  requireAuth,
  passkeyLimiter,
  async (req: AuthedRequest, res: Response) => {
    const { rpID } = webAuthnContext(req);
    res.json(await passkeyRegistrationOptions(req.auth!.user, rpID));
  },
);

app.post(
  '/api/auth/passkey/register-verify',
  requireAuth,
  passkeyLimiter,
  asAuth(async (req, res) => {
    const { rpID, origin } = webAuthnContext(req);
    await verifyPasskeyRegistration(req.auth!.user, req.body?.response, origin, rpID);
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/auth/passkey',
  requireAuth,
  asAuth(async (req, res) => {
    await removePasskey(req.auth!.user.id);
    res.json({ ok: true });
  }),
);

app.post('/api/auth/passkey/login-options', passkeyLimiter, async (req: Request, res: Response) => {
  const { rpID } = webAuthnContext(req);
  res.json(await passkeyAuthenticationOptions(rpID));
});

app.post(
  '/api/auth/passkey/login-verify',
  passkeyLimiter,
  asAuth(async (req, res) => {
    const { rpID, origin } = webAuthnContext(req);
    res.json(await verifyPasskeyAuthentication(req.body?.response, origin, rpID));
  }),
);

// ---------- 知识数据（按用户隔离） ----------
app.get('/api/data', requireAuth, async (req: AuthedRequest, res: Response) => {
  const snapshot = await readSnapshot(req.auth!.user.id);
  res.json(snapshot);
});

app.put('/api/data', requireAuth, async (req: AuthedRequest, res: Response) => {
  const limitError = validateDocsPayload(req.body?.docs);
  if (limitError) {
    res.status(400).json({ error: limitError });
    return;
  }
  const docs = sanitizeDocs(req.body?.docs);
  if (!docs) {
    res.status(400).json({ error: 'docs 必须是数组。' });
    return;
  }
  const activeDocId =
    typeof req.body?.activeDocId === 'string' ? req.body.activeDocId : null;
  const snapshot = { docs, activeDocId, updatedAt: Date.now() };
  // 写失败会抛 StoreError（503），不会再出现「返回 200 但没存上」
  await writeSnapshot(req.auth!.user.id, snapshot);
  console.log(`[store] 已保存 ${docs.length} 个会话 · 用户 ${req.auth!.user.id}`);
  res.json({ ok: true, updatedAt: snapshot.updatedAt });
});

/** 用户自带配置：格式可用才采用，否则回退到服务端配置 */
function readUserAiConfig(raw: unknown): AiConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const baseUrl = typeof item.baseUrl === 'string' ? item.baseUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof item.apiKey === 'string' ? item.apiKey.trim() : '';
  const model = typeof item.model === 'string' ? item.model.trim() : '';
  if (!baseUrl || !apiKey || !model || !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    return null;
  }
  return { baseUrl, apiKey, model };
}

const NO_AI_MESSAGE = '尚未配置 AI，请先在设置中填写 API Key。';

function parseChatMessages(
  rawBody: unknown,
): { messages: ChatMessage[]; context: string } | null {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages: ChatMessage[] = [];
  for (const item of rawMessages.slice(-MAX_CHAT_MESSAGES)) {
    const role = (item as { role?: unknown })?.role;
    const content = sanitizeChatContent((item as { content?: unknown })?.content);
    if ((role === 'user' || role === 'assistant') && content) {
      messages.push({ role, content });
    }
  }
  if (messages.length === 0 || messages[messages.length - 1]?.role !== 'user') {
    return null;
  }
  const context = typeof body.context === 'string' ? body.context.slice(0, MAX_CHAT_CONTEXT) : '';
  return { messages, context };
}

function buildSystemMessage(context: string): ChatMessage {
  return {
    role: 'system',
    content: [
      '你是「回源」的知识学习助手，帮助用户理解当前会话中的材料。',
      '回答要简洁、具体，优先使用当前材料中的概念；材料没有覆盖的内容要明确说明，不要编造。',
      context ? `当前会话材料：\n${context}` : '当前没有打开具体会话，可做通用学习答疑。',
    ].join('\n'),
  };
}

app.get('/api/ai/status', (_req, res) => {
  res.json({
    available: Boolean(config.ai),
    model: config.ai?.model ?? null,
    baseUrl: config.ai?.baseUrl ?? null,
  });
});

app.post('/api/ai/test', requireAuth, aiLimiter, async (_req: Request, res: Response) => {
  if (!config.ai) {
    res.status(503).json({ error: NO_AI_MESSAGE });
    return;
  }
  try {
    const result = await testConnection(config.ai);
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/ai/chat', requireAuth, aiLimiter, async (req: AuthedRequest, res: Response) => {
  // 用户自带 Key 优先，其次使用 .env 里的服务端配置
  const ai = readUserAiConfig(req.body?.config) ?? config.ai;
  if (!ai) {
    res.status(503).json({ error: NO_AI_MESSAGE });
    return;
  }
  const parsed = parseChatMessages(req.body);
  if (!parsed) {
    res.status(400).json({ error: '请求缺少有效的 user 消息。' });
    return;
  }
  try {
    const reply = await chat(
      ai,
      [buildSystemMessage(parsed.context), ...parsed.messages],
      config.extractTimeoutMs,
    );
    console.log(`[ai] chat ok · ${parsed.messages.length} 条消息`);
    res.json({ reply });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ai] chat failed · ${message}`);
    res.status(502).json({ error: message });
  }
});

app.post('/api/ai/chat/stream', requireAuth, aiLimiter, async (req: AuthedRequest, res: Response) => {
  const ai = readUserAiConfig(req.body?.config) ?? config.ai;
  if (!ai) {
    res.status(503).json({ error: NO_AI_MESSAGE });
    return;
  }
  const parsed = parseChatMessages(req.body);
  if (!parsed) {
    res.status(400).json({ error: '请求缺少有效的 user 消息。' });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const reply = await chatStream(
      ai,
      [buildSystemMessage(parsed.context), ...parsed.messages],
      config.extractTimeoutMs,
      (delta) => send({ delta }),
      controller.signal,
    );
    send({ done: true });
    console.log(`[ai] chat stream ok · ${reply.length} 字`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!controller.signal.aborted) {
      send({ error: message });
    }
    console.warn(`[ai] chat stream failed · ${message}`);
  } finally {
    res.end();
  }
});

app.post('/api/ai/extract', requireAuth, aiLimiter, async (req: AuthedRequest, res: Response) => {
  const ai = readUserAiConfig(req.body?.config) ?? config.ai;
  if (!ai) {
    res.status(503).json({ error: NO_AI_MESSAGE });
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
    const nodes = await extractChunk(ai, text, config.extractTimeoutMs);
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
  const detail = (error as { detail?: string }).detail;
  if (detail) {
    console.error(`[api] ${detail}`);
  }
  const message = error instanceof Error ? error.message : '服务端未知错误。';
  res.status(status).json({ error: message });
});

export default app;

if (!process.env.VERCEL) {
  app.listen(config.port, '127.0.0.1', () => {
    console.log(`[api] http://127.0.0.1:${config.port}`);
    console.log(
      config.ai
        ? `[ai] configured · ${config.ai.model} · ${config.ai.baseUrl}`
        : '[ai] not configured · copy .env.example to .env and fill LLM_API_KEY',
    );
  });
}
