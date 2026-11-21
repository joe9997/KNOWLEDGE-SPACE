import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type { User } from './types';
import {
  isLocalToken,
  localChangePassword,
  localLogin,
  localMe,
  localRegister,
  localUpdateProfile,
} from './localAuth';

const TOKEN_KEY = 'huiyuan.auth.token.v1';

/**
 * 静态部署（GitHub Pages / 单文件 HTML）没有后端：
 * 账号改为浏览器本地实现，避免 POST /api/auth/* 落到静态服务器返回 405。
 */
export const STATIC_DEPLOY = import.meta.env.VITE_STATIC_HOST === '1';

/**
 * 生产部署时（GitHub Pages 托前端、Vercel 托后端），
 * 前端需要直连绝对 URL；开发时 vite proxy 把 /api 转发到本地后端，用相对路径即可。
 * .env.production 里配置 VITE_API_BASE_URL=https://your-api.vercel.app，
 * 不配置则退回相对路径（dev 或前后端同端口）。
 */
export function resolveApiUrl(path: string): string {
  const base = import.meta.env.VITE_API_BASE_URL;
  if (!base) return path;
  // base 去掉末尾斜杠，path 确保以 /api 开头
  const normalizedBase = base.replace(/\/+$/, '');
  return path.startsWith('/') ? `${normalizedBase}${path}` : `${normalizedBase}/${path}`;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 带 HTTP 状态码的接口错误，调用方可以据此区分「没登录」和「后端挂了」 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 统一构造带 Bearer 的请求头；没有 token 时退化成普通请求 */
export function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const token = getToken();
  // 本地账号的 token 只在前端使用，不发给后端
  if (token && !isLocalToken(token)) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
}

/**
 * 所有需要登录态的请求都从这里走。
 * 以前 `/api/data`、`/api/ai/extract`、`/api/ai/chat` 都是裸 fetch，
 * 后端加上 requireAuth 之后全部 401，云同步和服务端 AI 静默失效。
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(resolveApiUrl(path), { ...init, headers: authHeaders(init.headers) });
  if (response.status === 401 && getToken() && !isLocalToken(getToken())) {
    // token 已失效：清掉，避免每次请求都带着一个死 token 反复 401
    clearToken();
  }
  return response;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && body.error) {
      return body.error;
    }
  } catch {
    // ignore
  }
  return `HTTP ${response.status}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const response = await apiFetch(path, { ...init, headers });
  if (!response.ok) {
    throw new ApiError(response.status, await readError(response));
  }
  return (await response.json()) as T;
}

export interface AuthResult {
  user: User;
  token: string;
}

export async function apiRegister(input: {
  email: string;
  username: string;
  password: string;
}): Promise<AuthResult> {
  const result = STATIC_DEPLOY
    ? await localRegister(input)
    : await request<AuthResult>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(input),
      });
  setToken(result.token);
  return result;
}

export async function apiLogin(identifier: string, password: string): Promise<AuthResult> {
  const result = STATIC_DEPLOY
    ? await localLogin(identifier, password)
    : await request<AuthResult>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
      });
  setToken(result.token);
  return result;
}

export async function apiLogout(): Promise<void> {
  if (STATIC_DEPLOY) {
    clearToken();
    return;
  }
  try {
    await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  } finally {
    clearToken();
  }
}

export async function apiMe(): Promise<User | null> {
  const token = getToken();
  if (!token) {
    return null;
  }
  if (STATIC_DEPLOY) {
    return localMe(token);
  }
  try {
    const result = await request<{ user: User }>('/api/auth/me');
    return result.user;
  } catch {
    // 401 时 apiFetch 已经清掉 token；网络错误 / 后端没起时保留 token，
    // 免得用户一断网或后端重启就被静默登出。
    return null;
  }
}

export async function apiUpdateProfile(input: {
  username?: string;
  email?: string;
  avatar?: string | null;
}): Promise<User> {
  if (STATIC_DEPLOY) {
    return localUpdateProfile(getToken(), input);
  }
  const result = await request<{ user: User }>('/api/auth/profile', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return result.user;
}

export async function apiChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (STATIC_DEPLOY) {
    await localChangePassword(getToken(), currentPassword, newPassword);
    return;
  }
  await request<{ ok: boolean }>('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// ---------- Passkey ----------
export function passkeySupported(): boolean {
  // 本地账号没有服务端 challenge，静态部署下不提供 Passkey
  return STATIC_DEPLOY ? false : browserSupportsWebAuthn();
}

export async function passkeyPlatformAvailable(): Promise<boolean> {
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return false;
  }
}

/** 登录态下注册一枚 Passkey（在用户设置里调用） */
export async function registerPasskey(): Promise<void> {
  const options = await request<Record<string, unknown>>('/api/auth/passkey/register-options', {
    method: 'POST',
    body: '{}',
  });
  const registration = await startRegistration({
    optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'],
  });
  await request<{ ok: boolean }>('/api/auth/passkey/register-verify', {
    method: 'POST',
    body: JSON.stringify({ response: registration }),
  });
}

export async function removePasskey(): Promise<void> {
  await request<{ ok: boolean }>('/api/auth/passkey', { method: 'DELETE' });
}

/** 未登录时用 Passkey 登录 */
export async function loginWithPasskey(): Promise<AuthResult> {
  const options = await request<Record<string, unknown>>('/api/auth/passkey/login-options', {
    method: 'POST',
    body: '{}',
  });
  const authentication = await startAuthentication({
    optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
  });
  const result = await request<AuthResult>('/api/auth/passkey/login-verify', {
    method: 'POST',
    body: JSON.stringify({ response: authentication }),
  });
  setToken(result.token);
  return result;
}
