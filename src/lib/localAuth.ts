import type { User } from './types';

/**
 * 静态部署（GitHub Pages / 单文件 HTML）没有后端，账号系统改为纯浏览器本地实现。
 * 数据只保存在当前浏览器，换设备不会同步；密码用加盐 SHA-256 存储，仅用于本地演示。
 */

const ACCOUNTS_KEY = 'huiyuan.local.accounts.v1';
const TOKEN_PREFIX = 'local.';

interface LocalAccount {
  id: string;
  email: string;
  username: string;
  avatar: string | null;
  salt: string;
  hash: string;
  createdAt: number;
}

function readAccounts(): LocalAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LocalAccount[]) : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: LocalAccount[]): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    throw new Error('浏览器禁止本地存储，无法创建本地账号');
  }
}

function randomHex(size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${password}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function publicUser(account: LocalAccount): User {
  return {
    id: account.id,
    email: account.email,
    username: account.username,
    avatar: account.avatar,
    hasPassword: true,
    hasPasskey: false,
    createdAt: account.createdAt,
  };
}

function tokenOf(account: LocalAccount): string {
  return `${TOKEN_PREFIX}${account.id}`;
}

function userIdFromToken(token: string | null): string | null {
  if (!token || !token.startsWith(TOKEN_PREFIX)) {
    return null;
  }
  const id = token.slice(TOKEN_PREFIX.length);
  return id || null;
}

function findAccount(token: string | null): LocalAccount | null {
  const id = userIdFromToken(token);
  if (!id) {
    return null;
  }
  return readAccounts().find((account) => account.id === id) ?? null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLocalToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith(TOKEN_PREFIX);
}

export async function localRegister(input: {
  email: string;
  username: string;
  password: string;
}): Promise<{ user: User; token: string }> {
  const email = input.email.trim().toLowerCase();
  const username = input.username.trim();
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error('邮箱格式不正确');
  }
  if (username.length < 2 || username.length > 20) {
    throw new Error('用户名需为 2–20 个字符');
  }
  if (input.password.length < 8) {
    throw new Error('密码至少 8 位');
  }
  const accounts = readAccounts();
  if (accounts.some((account) => account.email.toLowerCase() === email)) {
    throw new Error('该邮箱已注册');
  }
  if (accounts.some((account) => account.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('该用户名已被占用');
  }
  const salt = randomHex(16);
  const account: LocalAccount = {
    id: `local-${randomHex(8)}`,
    email,
    username,
    avatar: null,
    salt,
    hash: await hashPassword(input.password, salt),
    createdAt: Date.now(),
  };
  writeAccounts([...accounts, account]);
  return { user: publicUser(account), token: tokenOf(account) };
}

export async function localLogin(
  identifier: string,
  password: string,
): Promise<{ user: User; token: string }> {
  const key = identifier.trim().toLowerCase();
  const account = readAccounts().find(
    (item) => item.email.toLowerCase() === key || item.username.toLowerCase() === key,
  );
  if (!account) {
    throw new Error('账号或密码不正确');
  }
  const hash = await hashPassword(password, account.salt);
  if (hash !== account.hash) {
    throw new Error('账号或密码不正确');
  }
  return { user: publicUser(account), token: tokenOf(account) };
}

export function localMe(token: string | null): User | null {
  const account = findAccount(token);
  return account ? publicUser(account) : null;
}

export function localUpdateProfile(
  token: string | null,
  input: { username?: string; email?: string; avatar?: string | null },
): User {
  const account = findAccount(token);
  if (!account) {
    throw new Error('登录状态已失效，请重新登录');
  }
  const accounts = readAccounts();
  const next: LocalAccount = { ...account };
  if (input.username !== undefined) {
    const username = input.username.trim();
    if (username.length < 2 || username.length > 20) {
      throw new Error('用户名需为 2–20 个字符');
    }
    if (
      accounts.some(
        (item) => item.id !== account.id && item.username.toLowerCase() === username.toLowerCase(),
      )
    ) {
      throw new Error('该用户名已被占用');
    }
    next.username = username;
  }
  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      throw new Error('邮箱格式不正确');
    }
    if (accounts.some((item) => item.id !== account.id && item.email.toLowerCase() === email)) {
      throw new Error('该邮箱已注册');
    }
    next.email = email;
  }
  if (input.avatar !== undefined) {
    next.avatar = input.avatar;
  }
  writeAccounts(accounts.map((item) => (item.id === account.id ? next : item)));
  return publicUser(next);
}

export async function localChangePassword(
  token: string | null,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const account = findAccount(token);
  if (!account) {
    throw new Error('登录状态已失效，请重新登录');
  }
  if (newPassword.length < 8) {
    throw new Error('新密码至少 8 位');
  }
  const currentHash = await hashPassword(currentPassword, account.salt);
  if (currentHash !== account.hash) {
    throw new Error('当前密码不正确');
  }
  const salt = randomHex(16);
  const next: LocalAccount = { ...account, salt, hash: await hashPassword(newPassword, salt) };
  writeAccounts(readAccounts().map((item) => (item.id === account.id ? next : item)));
}
