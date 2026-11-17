import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { readServerConfig } from './config';
import { extractChunk, testConnection } from './ai';

const MAX_CHUNK_CHARS = 4000;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = readServerConfig();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

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

app.get('/api/ai/status', (_req, res) => {
  res.json({
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
