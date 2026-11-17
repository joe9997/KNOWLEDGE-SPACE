import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type { User } from './types';

const TOKEN_KEY = 'huiyuan.auth.token.v1';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
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
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    throw new Error(await readError(response));
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
  const result = await request<AuthResult>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setToken(result.token);
  return result;
}

export async function apiLogin(identifier: string, password: string): Promise<AuthResult> {
  const result = await request<AuthResult>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });
  setToken(result.token);
  return result;
}

export async function apiLogout(): Promise<void> {
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
  try {
    const result = await request<{ user: User }>('/api/auth/me');
    return result.user;
  } catch {
    clearToken();
    return null;
  }
}

export async function apiUpdateProfile(input: {
  username?: string;
  email?: string;
  avatar?: string | null;
}): Promise<User> {
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
  await request<{ ok: boolean }>('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// ---------- Passkey ----------
export function passkeySupported(): boolean {
  return browserSupportsWebAuthn();
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
