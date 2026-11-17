export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ServerConfig {
  port: number;
  ai: AiConfig | null;
  extractTimeoutMs: number;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_PORT = 3001;
const DEFAULT_EXTRACT_TIMEOUT_MS = 90_000;

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 读取仓库根目录的 .env；没有该文件时静默跳过，仍以真实环境变量为准。 */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 属于正常情况（例如 CI 直接注入环境变量）
  }
}

export function readServerConfig(): ServerConfig {
  loadEnvFile();
  const baseUrl = normalizeBaseUrl(process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL);
  const apiKey = (process.env.LLM_API_KEY ?? '').trim();
  const model = (process.env.LLM_MODEL ?? '').trim() || DEFAULT_MODEL;
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const timeout = Number(process.env.LLM_TIMEOUT_MS ?? DEFAULT_EXTRACT_TIMEOUT_MS);

  return {
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    extractTimeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : DEFAULT_EXTRACT_TIMEOUT_MS,
    ai: apiKey && baseUrl && model ? { baseUrl, apiKey, model } : null,
  };
}
