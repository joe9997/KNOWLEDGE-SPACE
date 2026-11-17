import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { readServerConfig } from './config';
import { chat, extractChunk, testConnection } from './ai';
import type { ChatContent, ChatMessage } from './ai';
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
} from './auth';
import type { UserRecord } from './auth';
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

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
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

/** 把认证业务抛出的 Error 统一映射为 400 响应 */
function asAuth(handler: (req: AuthedRequest, res: Response) => Promise<unknown>) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(new HttpError(400, error instanceof Error ? error.message : String(error)));
    }
  };
}

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

// ---------- 认证 ----------
app.post(
  '/api/auth/register',
  asAuth(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    res.json(await registerUser({ email, username, password }));
  }),
);

app.post(
  '/api/auth/login',
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
    await changePassword(req.auth!.user.id, currentPassword, newPassword);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/auth/passkey/register-options',
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const { rpID } = webAuthnContext(req);
    res.json(await passkeyRegistrationOptions(req.auth!.user, rpID));
  },
);

app.post(
  '/api/auth/passkey/register-verify',
  requireAuth,
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

app.post('/api/auth/passkey/login-options', async (req: Request, res: Response) => {
  const { rpID } = webAuthnContext(req);
  res.json(await passkeyAuthenticationOptions(rpID));
});

app.post(
  '/api/auth/passkey/login-verify',
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
  const docs = sanitizeDocs(req.body?.docs);
  if (!docs) {
    res.status(400).json({ error: 'docs 必须是数组。' });
    return;
  }
  const activeDocId =
    typeof req.body?.activeDocId === 'string' ? req.body.activeDocId : null;
  const snapshot = { docs, activeDocId, updatedAt: Date.now() };
  await writeSnapshot(req.auth!.user.id, snapshot);
  console.log(`[store] 已保存 ${docs.length} 个会话 · 用户 ${req.auth!.user.id}`);
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

app.post('/api/ai/chat', requireAuth, async (req: AuthedRequest, res: Response) => {
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

app.post('/api/ai/extract', requireAuth, async (req: AuthedRequest, res: Response) => {
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
