import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';

export interface PasskeyRecord {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}

export interface UserRecord {
  id: string;
  email: string;
  username: string;
  passwordHash: string | null;
  avatar: string | null;
  passkeys: PasskeyRecord[];
  createdAt: number;
}

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  avatar: string | null;
  hasPassword: boolean;
  hasPasskey: boolean;
  createdAt: number;
}

interface SessionRecord {
  userId: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const usersFile = path.join(dataDir, 'users.json');
const sessionsFile = path.join(dataDir, 'sessions.json');

// ---- 待消费的 WebAuthn challenge（注册按用户，登录全局单例） ----
const pendingRegistration = new Map<string, { challenge: string; expiresAt: number }>();
let pendingLogin: { challenge: string; expiresAt: number } | null = null;

function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) {
    return false;
  }
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

let writeQueue: Promise<void> = Promise.resolve();

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, payload: unknown): Promise<void> {
  const data = JSON.stringify(payload, null, 2);
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dataDir, { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, data, 'utf8');
      await rename(temp, file);
    })
    .catch((error: unknown) => {
      console.warn(`[auth] 写入失败 · ${error instanceof Error ? error.message : String(error)}`);
    });
  return writeQueue;
}

async function loadUsers(): Promise<UserRecord[]> {
  const parsed = await readJson<{ users?: UserRecord[] }>(usersFile, { users: [] });
  return Array.isArray(parsed.users) ? parsed.users : [];
}

async function saveUsers(users: UserRecord[]): Promise<void> {
  await writeJson(usersFile, { users });
}

async function loadSessions(): Promise<Record<string, SessionRecord>> {
  const parsed = await readJson<{ sessions?: Record<string, SessionRecord> }>(sessionsFile, {
    sessions: {},
  });
  return parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
}

async function saveSessions(sessions: Record<string, SessionRecord>): Promise<void> {
  await writeJson(sessionsFile, { sessions });
}

export async function findUserByIdentifier(identifier: string): Promise<UserRecord | null> {
  const users = await loadUsers();
  const needle = identifier.trim().toLowerCase();
  return (
    users.find(
      (user) => user.email.toLowerCase() === needle || user.username.toLowerCase() === needle,
    ) ?? null
  );
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const users = await loadUsers();
  return users.find((user) => user.id === id) ?? null;
}

export async function findUserByCredentialId(credentialId: string): Promise<UserRecord | null> {
  const users = await loadUsers();
  return users.find((user) => user.passkeys.some((key) => key.credentialId === credentialId)) ?? null;
}

async function updateUser(updated: UserRecord): Promise<void> {
  const users = await loadUsers();
  await saveUsers(users.map((user) => (user.id === updated.id ? updated : user)));
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    avatar: user.avatar,
    hasPassword: Boolean(user.passwordHash),
    hasPasskey: user.passkeys.length > 0,
    createdAt: user.createdAt,
  };
}

function validateEmail(email: string): string | null {
  if (!EMAIL_RE.test(email.trim())) {
    return '邮箱格式不正确';
  }
  return null;
}

function validateUsername(username: string): string | null {
  const value = username.trim();
  if (value.length < 2 || value.length > 20) {
    return '用户名需为 2–20 个字符';
  }
  return null;
}

function validatePassword(password: string): string | null {
  if (password.length < 8) {
    return '密码至少 8 位';
  }
  return null;
}

export async function registerUser(input: {
  email: string;
  username: string;
  password: string;
}): Promise<{ user: PublicUser; token: string }> {
  const email = input.email.trim().toLowerCase();
  const username = input.username.trim();
  const emailError = validateEmail(email);
  const usernameError = validateUsername(username);
  const passwordError = validatePassword(input.password);
  if (emailError || usernameError || passwordError) {
    throw new Error(emailError ?? usernameError ?? passwordError ?? '注册信息不完整');
  }

  const users = await loadUsers();
  if (users.some((user) => user.email.toLowerCase() === email)) {
    throw new Error('该邮箱已注册');
  }
  if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('该用户名已被占用');
  }

  const user: UserRecord = {
    id: randomUUID(),
    email,
    username,
    passwordHash: hashPassword(input.password),
    avatar: null,
    passkeys: [],
    createdAt: Date.now(),
  };
  users.push(user);
  await saveUsers(users);

  const token = await createSession(user.id);
  return { user: toPublicUser(user), token };
}

export async function loginWithPassword(
  identifier: string,
  password: string,
): Promise<{ user: PublicUser; token: string }> {
  const user = await findUserByIdentifier(identifier);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw new Error('账号或密码不正确');
  }
  const token = await createSession(user.id);
  return { user: toPublicUser(user), token };
}

async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const sessions = await loadSessions();
  sessions[token] = { userId, expiresAt: Date.now() + SESSION_TTL_MS };
  await saveSessions(sessions);
  return token;
}

export async function resolveSession(token: string): Promise<UserRecord | null> {
  const sessions = await loadSessions();
  const session = sessions[token];
  if (!session) {
    return null;
  }
  if (session.expiresAt < Date.now()) {
    delete sessions[token];
    await saveSessions(sessions);
    return null;
  }
  return findUserById(session.userId);
}

export async function deleteSession(token: string): Promise<void> {
  const sessions = await loadSessions();
  delete sessions[token];
  await saveSessions(sessions);
}

export async function updateProfile(
  userId: string,
  input: { username?: string; email?: string; avatar?: string | null },
): Promise<PublicUser> {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error('用户不存在');
  }
  const users = await loadUsers();

  if (input.username !== undefined) {
    const username = input.username.trim();
    const error = validateUsername(username);
    if (error) {
      throw new Error(error);
    }
    if (
      users.some((item) => item.id !== userId && item.username.toLowerCase() === username.toLowerCase())
    ) {
      throw new Error('该用户名已被占用');
    }
    user.username = username;
  }

  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    const error = validateEmail(email);
    if (error) {
      throw new Error(error);
    }
    if (users.some((item) => item.id !== userId && item.email.toLowerCase() === email)) {
      throw new Error('该邮箱已被使用');
    }
    user.email = email;
  }

  if (input.avatar !== undefined) {
    if (input.avatar && !/^data:image\/(png|jpe?g|webp);base64,/i.test(input.avatar)) {
      throw new Error('头像格式不支持');
    }
    user.avatar = input.avatar || null;
  }

  await updateUser(user);
  return toPublicUser(user);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error('用户不存在');
  }
  if (user.passwordHash && !verifyPassword(currentPassword, user.passwordHash)) {
    throw new Error('当前密码不正确');
  }
  const error = validatePassword(newPassword);
  if (error) {
    throw new Error(error);
  }
  user.passwordHash = hashPassword(newPassword);
  await updateUser(user);
}

export async function passkeyRegistrationOptions(
  user: UserRecord,
  rpID: string,
): Promise<Record<string, unknown>> {
  const options = await generateRegistrationOptions({
    rpName: '回源 · KNOWLEDGE SPACE',
    rpID,
    userName: user.email,
    userID: createHash('sha256').update(user.id).digest(),
    userDisplayName: user.username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: user.passkeys.map((key) => ({
      id: key.credentialId,
      transports: key.transports,
    })),
  });
  pendingRegistration.set(user.id, { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return options as unknown as Record<string, unknown>;
}

export async function verifyPasskeyRegistration(
  user: UserRecord,
  response: RegistrationResponseJSON,
  origin: string,
  rpID: string,
): Promise<void> {
  const pending = pendingRegistration.get(user.id);
  pendingRegistration.delete(user.id);
  if (!pending || pending.expiresAt < Date.now()) {
    throw new Error('注册会话已过期，请重试');
  }
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Passkey 校验失败');
  }
  const { credential } = verification.registrationInfo;
  if (user.passkeys.some((key) => key.credentialId === credential.id)) {
    throw new Error('该 Passkey 已注册');
  }
  user.passkeys.push({
    credentialId: credential.id,
    publicKey: toB64url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
  });
  await updateUser(user);
}

export async function removePasskey(userId: string): Promise<void> {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error('用户不存在');
  }
  user.passkeys = [];
  await updateUser(user);
}

export async function passkeyAuthenticationOptions(rpID: string): Promise<Record<string, unknown>> {
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
  });
  pendingLogin = { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS };
  return options as unknown as Record<string, unknown>;
}

export async function verifyPasskeyAuthentication(
  response: AuthenticationResponseJSON,
  origin: string,
  rpID: string,
): Promise<{ user: PublicUser; token: string }> {
  const user = await findUserByCredentialId(response.id);
  if (!user) {
    throw new Error('未找到对应的 Passkey 用户');
  }
  const key = user.passkeys.find((item) => item.credentialId === response.id);
  if (!key) {
    throw new Error('Passkey 凭证无效');
  }
  const challenge = pendingLogin;
  pendingLogin = null;
  if (!challenge || challenge.expiresAt < Date.now()) {
    throw new Error('登录会话已过期，请重试');
  }
  const credential: WebAuthnCredential = {
    id: key.credentialId,
    publicKey: fromB64url(key.publicKey),
    counter: key.counter,
    transports: key.transports,
  };
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
    requireUserVerification: true,
  });
  if (!verification.verified) {
    throw new Error('Passkey 校验失败');
  }
  key.counter = verification.authenticationInfo.newCounter;
  await updateUser(user);
  const token = await createSession(user.id);
  return { user: toPublicUser(user), token };
}
