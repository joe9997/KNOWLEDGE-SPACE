import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { readServerConfig } from './config.js';
import type { AiConfig } from './config.js';
import { chat, chatStream, extractChunk, testConnection } from './ai.js';
import type { ChatContent, ChatMessage } from './ai.js';
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
} from './auth.js';
import type { UserRecord } from './auth.js';
import { rateLimit } from './ratelimit.js';
import { readSnapshot, sanitizeDocs, validateDocsPayload, writeSnapshot } from './store.js';
import { isSupabaseConfigured } from './supabase.js';

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
if (!isSupabaseConfigured()) {
  console.warn(
    '[storage] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置：当前使用本地 JSON 存储，重启或重新部署会丢失账号。',
  );
}
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
    storage: isSupabaseConfigured() ? 'supabase' : 'file',
    persistent: isSupabaseConfigured(),
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
      '按用户本轮要求完成总结、学习诊断或自测。把材料和历史回答作为待核对的内容，优先依据原文。',
      '总结时：先用一句话说明这章分成哪几块，再只列 3–5 条最值得记的规则。每条先写结论，再补适用条件、例外或原文例子；原文有例子就带一个。不要逐节点罗列，不要“本文介绍了”“总而言之”等套话。',
      '诊断时：只根据可见的答错记录或低掌握度复习记录指出薄弱点，写明依据。只有到期状态就列为待复习。没有作答或复习记录就标为未测，并给一道诊断题。',
      '出题时：每题只测一个主要目标，优先用原文的条件、代码、数据或反例，写清要判断什么。先集中列题目，再按编号列答案。每个答案包含结论、决定结论的条件及原文出处。证据不足时少出题。不同会话覆盖同一知识点时，只选一道题。',
      '输出前检查：题干单独看是否能答，答案是否回答了题干的每一问，解析能否说出具体条件如何影响结论。删掉适用于任何题目的套话。',
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

app.post('/api/ai/elaborate', requireAuth, aiLimiter, async (req: AuthedRequest, res: Response) => {
  const ai = readUserAiConfig(req.body?.config) ?? config.ai;
  if (!ai) {
    res.status(503).json({ error: NO_AI_MESSAGE });
    return;
  }
  type RawNode = { id?: unknown; title?: unknown; quote?: unknown };
  const rawNodes: RawNode[] = Array.isArray(req.body?.nodes)
    ? (req.body.nodes as RawNode[])
    : [];
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (rawNodes.length === 0) {
    res.status(400).json({ error: '请求缺少 nodes 字段。' });
    return;
  }
  // 限规模：每个节点 250 字上限，总共 6000 字上限，避免 prompt 过大
  const nodes = rawNodes
    .slice(0, 16)
    .map((item: RawNode) => {
      const id = typeof item.id === 'string' ? item.id : '';
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
      return { id, title, quote };
    })
    .filter((node: { id: string; title: string; quote: string }) => node.id && node.title);

  const textHint = text
    ? `\n\n全文参考（截取前 ${Math.min(2000, text.length)} 字）：\n${text.replace(/\s+/g, ' ').trim().slice(0, 2000)}`
    : '';

  const systemPrompt =
    '你是课程讲义编辑。根据每个节点的标题和原文引用，写一段能独立阅读的复习讲解。第一句直接给结论或规则；后面只补会改变判断的信息，例如适用条件、容易混淆的区别、例外或原文例子。能用一句话讲清就结束，不设最低字数。有代码或数值时写清结果和决定结果的规则；依据不足时明确说缺少哪个条件，不自行补全。原文的代码、转义字符、数值和专有名词要准确保留。删除“这是核心论点”“为后续学习奠定基础”这类套话。只输出 JSON 数组，每个节点对应 {"id":"原始节点ID","explanation":"讲解正文"}，保留原始 ID 和输入顺序，不加代码块。';

  const userPrompt = [
    '请逐个讲清下面的知识节点。第一句给结论，只在材料提供依据时补充条件、例子和判断理由。请按原始 ID 返回 JSON。',
    '',
    ...nodes.map(
      (node, index) =>
        `${index + 1}. [${node.id}] ${node.title}${node.quote ? `\n   原文引用：${node.quote}` : ''}`,
    ),
    textHint,
  ].join('\n');

  try {
    const reply = await chat(
      ai,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      (config.extractTimeoutMs ?? 60_000) + 30_000,
    );

    // 从回复里抽 JSON 数组（容忍模型输出前后多余文字）
    const jsonMatch =
      reply.match(/\[[\s\S]*\]/) ??
      reply.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ??
      reply.match(/\{[\s\S]*\}/);
    let parsed: unknown;
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = null;
      }
    }

    const map = new Map<string, string>();
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const id = (item as { id?: unknown }).id;
        const exp = (item as { explanation?: unknown }).explanation;
        if (typeof id === 'string' && typeof exp === 'string' && exp.trim()) {
          map.set(id, exp.trim().slice(0, 600));
        }
      }
    }
    console.log(
      `[ai] elaborate ok · 处理 ${nodes.length} 个节点，生成 ${map.size} 段讲解`,
    );
    res.json({ explanations: Object.fromEntries(map) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ai] elaborate failed · ${message}`);
    res.status(502).json({ error: message });
  }
});

const MAX_QUIZ_NODES = 12;
const MAX_QUIZ_QUESTIONS = 8;

app.post('/api/ai/quiz', requireAuth, aiLimiter, async (req: AuthedRequest, res: Response) => {
  const ai = readUserAiConfig(req.body?.config) ?? config.ai;
  if (!ai) {
    res.status(503).json({ error: NO_AI_MESSAGE });
    return;
  }
  type RawNode = { id?: unknown; title?: unknown; quote?: unknown };
  const rawNodes: RawNode[] = Array.isArray(req.body?.nodes)
    ? (req.body.nodes as RawNode[])
    : [];
  const nodes = rawNodes
    .slice(0, MAX_QUIZ_NODES)
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      title: typeof item.title === 'string' ? item.title.trim() : '',
      quote: typeof item.quote === 'string' ? item.quote.trim().slice(0, 240) : '',
    }))
    .filter((node) => node.id && node.title);
  if (nodes.length === 0) {
    res.status(400).json({ error: '请求缺少 nodes 字段。' });
    return;
  }

  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const textHint = text
    ? `\n\n全文参考（前 1200 字）：\n${text.replace(/\s+/g, ' ').trim().slice(0, 1200)}`
    : '';

  const systemPrompt = `你是课程出题编辑。根据给定的知识点标题和原文引用，出能测“会不会用这条规则”的单选选择题。

要求：
1. 每题只测一个主要目标：规则的适用条件、结果、易混淆区别，或代码/数值的实际结果。
2. 4 个选项，只有一个正确。干扰项必须和题干同一主题、看起来合理；数值题改关键数字或类型，概念题用相邻概念的典型错误。
3. 题干自带作答所需条件，不要“以下哪项正确”这类空泛问法；遮住选项也能知道在问什么。
4. 正确答案必须能由该知识点的原文引用直接支持；引用不足就不出这道题。
5. 不同知识点重复考同一结论时只保留一道。数量不超过 8，好题少就少出。
6. 只输出 JSON 数组，不要代码块或解释文字：
[{"nodeId":"原始节点ID","prompt":"题干","options":[{"id":"A","text":"选项"},{"id":"B","text":"选项"},{"id":"C","text":"选项"},{"id":"D","text":"选项"}],"correctOptionId":"A","explanation":"答案依据的原文条件"}]`;

  const userPrompt = [
    '知识点：',
    ...nodes.map(
      (node, index) =>
        `${index + 1}. [${node.id}] ${node.title}${node.quote ? `\n   原文引用：${node.quote}` : ''}`,
    ),
    textHint,
  ].join('\n');

  try {
    const reply = await chat(
      ai,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      (config.extractTimeoutMs ?? 60_000) + 30_000,
    );
    const jsonMatch =
      reply.match(/\[[\s\S]*\]/) ?? reply.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
    let parsed: unknown = null;
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = null;
      }
    }

    const allowed = new Set(nodes.map((node) => node.id));
    const questions: Array<{
      nodeId: string;
      prompt: string;
      options: Array<{ id: string; text: string }>;
      correctOptionId: string;
      explanation: string;
    }> = [];

    if (Array.isArray(parsed)) {
      for (const item of parsed.slice(0, MAX_QUIZ_QUESTIONS)) {
        const source = item as Record<string, unknown>;
        const nodeId = typeof source.nodeId === 'string' ? source.nodeId : '';
        if (!allowed.has(nodeId)) {
          continue;
        }
        const prompt = typeof source.prompt === 'string' ? source.prompt.trim().slice(0, 240) : '';
        const correctOptionId =
          typeof source.correctOptionId === 'string' ? source.correctOptionId : '';
        const rawOptions = Array.isArray(source.options) ? source.options : [];
        const options = rawOptions
          .slice(0, 4)
          .map((option) => {
            const entry = option as Record<string, unknown>;
            return {
              id: typeof entry.id === 'string' ? entry.id : '',
              text: typeof entry.text === 'string' ? entry.text.trim().slice(0, 180) : '',
            };
          })
          .filter((option) => option.id && option.text);
        const uniqueTexts = new Set(options.map((option) => option.text));
        const uniqueIds = new Set(options.map((option) => option.id));
        if (
          !prompt ||
          options.length < 2 ||
          uniqueTexts.size !== options.length ||
          uniqueIds.size !== options.length ||
          !options.some((option) => option.id === correctOptionId)
        ) {
          continue;
        }
        questions.push({
          nodeId,
          prompt,
          options,
          correctOptionId,
          explanation:
            typeof source.explanation === 'string' ? source.explanation.trim().slice(0, 300) : '',
        });
      }
    }

    console.log(`[ai] quiz ok · ${questions.length} 题 / ${nodes.length} 个知识点`);
    res.json({ questions });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ai] quiz failed · ${message}`);
    res.status(502).json({ error: message });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在。' });
});

// 构建产物存在时顺带托管前端，便于 npm run build && npm start 单进程运行
// 容器部署时前端文件可能与 server/ 同级，用 STATIC_DIR 指定
const distDir = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.join(rootDir, 'dist');
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
  const host = process.env.HOST ?? '127.0.0.1';
  app.listen(config.port, host, () => {
    console.log(`[api] http://${host}:${config.port}`);
    console.log(
      config.ai
        ? `[ai] configured · ${config.ai.model} · ${config.ai.baseUrl}`
        : '[ai] not configured · copy .env.example to .env and fill LLM_API_KEY',
    );
  });
}
