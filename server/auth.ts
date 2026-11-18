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
import { challengeFromResponse, saveChallenge, takeChallenge } from './challenges.ts';
import { getSupabase, isSupabaseConfigured } from './supabase.ts';

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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * 用于拼接 Supabase `.or()` 过滤器的标识符白名单。
 * 逗号是 PostgREST 的条件分隔符，`()"'\` 和 `% _ *` 会改变匹配语义，一律不允许出现。
 */
const SAFE_IDENTIFIER_RE = /^[^\s,()"'`\\%_:*]{1,200}$/;

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const usersFile = path.join(dataDir, 'users.json');
const sessionsFile = path.join(dataDir, 'sessions.json');

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
      console.warn(`[auth] write failed · ${error instanceof Error ? error.message : String(error)}`);
    });
  return writeQueue;
}

function rowToUser(row: Record<string, unknown> | null): UserRecord | null {
  if (!row) return null;
  return {
    id: row.id as string,
    email: row.email as string,
    username: row.username as string,
    passwordHash: (row.password_hash as string | null) ?? null,
    avatar: (row.avatar as string | null) ?? null,
    passkeys: Array.isArray(row.passkeys) ? (row.passkeys as PasskeyRecord[]) : [],
    createdAt: Number(row.created_at) || 0,
  };
}

function userToRow(u: UserRecord): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    password_hash: u.passwordHash,
    avatar: u.avatar,
    passkeys: u.passkeys,
    created_at: u.createdAt,
  };
}

async function loadUsers(): Promise<UserRecord[]> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from('users').select('*');
    if (error) {
      console.warn(`[auth] supabase loadUsers failed: ${error.message}; fallback`);
      const parsed = await readJson<{ users?: UserRecord[] }>(usersFile, { users: [] });
      return Array.isArray(parsed.users) ? parsed.users : [];
    }
    return (data as Record<string, unknown>[]).map(rowToUser).filter((u): u is UserRecord => u !== null);
  }
  const parsed = await readJson<{ users?: UserRecord[] }>(usersFile, { users: [] });
  return Array.isArray(parsed.users) ? parsed.users : [];
}

async function saveUsers(users: UserRecord[]): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    for (const u of users) {
      const { error } = await supabase
        .from('users')
        .upsert(userToRow(u), { onConflict: 'id' });
      if (error) {
        throw new Error(error.message);
      }
    }
    return;
  }
  await writeJson(usersFile, { users });
}

async function saveUser(user: UserRecord): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase
      .from('users')
      .upsert(userToRow(user), { onConflict: 'id' });
    if (error) throw new Error(error.message);
    return;
  }
  const users = await loadUsers();
  const idx = users.findIndex((u) => u.id === user.id);
  if (idx >= 0) {
    users[idx] = user;
  } else {
    users.push(user);
  }
  await saveUsers(users);
}

async function loadSessions(): Promise<Record<string, SessionRecord>> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from('sessions').select('token, user_id, expires_at');
    if (error) {
      console.warn(`[auth] supabase loadSessions failed: ${error.message}; fallback`);
      const parsed = await readJson<{ sessions?: Record<string, SessionRecord> }>(sessionsFile, { sessions: {} });
      return parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    }
    const result: Record<string, SessionRecord> = {};
    for (const row of data as Record<string, unknown>[]) {
      result[row.token as string] = {
        userId: row.user_id as string,
        expiresAt: Number(row.expires_at) || 0,
      };
    }
    return result;
  }
  const parsed = await readJson<{ sessions?: Record<string, SessionRecord> }>(sessionsFile, { sessions: {} });
  return parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
}

async function saveSessions(sessions: Record<string, SessionRecord>): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    const { data: existing } = await supabase.from('sessions').select('token');
    const existingTokens = new Set<string>((existing as Record<string, unknown>[]).map((r) => String(r.token)));
    const currentTokens = Object.keys(sessions);
    const toDelete = [...existingTokens].filter((t) => !currentTokens.includes(t));
    for (const token of toDelete) {
      await supabase.from('sessions').delete().eq('token', token);
    }
    for (const [token, rec] of Object.entries(sessions)) {
      await supabase
        .from('sessions')
        .upsert({ token, user_id: rec.userId, expires_at: rec.expiresAt }, { onConflict: 'token' });
    }
    return;
  }
  await writeJson(sessionsFile, { sessions });
}

async function saveSession(token: string, rec: SessionRecord): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase
      .from('sessions')
      .upsert({ token, user_id: rec.userId, expires_at: rec.expiresAt }, { onConflict: 'token' });
    if (error) throw new Error(error.message);
    return;
  }
  const sessions = await loadSessions();
  sessions[token] = rec;
  await saveSessions(sessions);
}

async function deleteSessionFromStore(token: string): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from('sessions').delete().eq('token', token);
    if (error) throw new Error(error.message);
    return;
  }
  const sessions = await loadSessions();
  delete sessions[token];
  await saveSessions(sessions);
}

export async function findUserByIdentifier(identifier: string): Promise<UserRecord | null> {
  const supabase = getSupabase();
  const needle = identifier.trim().toLowerCase();
  if (!needle || !SAFE_IDENTIFIER_RE.test(needle)) {
    // 非法字符直接当成「查不到」，避免被拼进 Supabase 过滤器
    return null;
  }
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .or(`email.eq.${needle},username.eq.${needle}`)
      .maybeSingle();
    if (!error && data) return rowToUser(data as Record<string, unknown>);
    const { data: data2, error: err2 } = await supabase
      .from('users')
      .select('*')
      .ilike('username', needle)
      .limit(1);
    if (!err2 && Array.isArray(data2) && data2.length > 0) {
      return rowToUser(data2[0] as Record<string, unknown>);
    }
  }
  const users = await loadUsers();
  return (
    users.find(
      (user) => user.email.toLowerCase() === needle || user.username.toLowerCase() === needle,
    ) ?? null
  );
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (!error && data) return rowToUser(data as Record<string, unknown>);
  }
  const users = await loadUsers();
  return users.find((user) => user.id === id) ?? null;
}

export async function findUserByCredentialId(credentialId: string): Promise<UserRecord | null> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .contains('passkeys', [{ credentialId }])
      .maybeSingle();
    if (!error && data) return rowToUser(data as Record<string, unknown>);
  }
  const users = await loadUsers();
  return users.find((user) => user.passkeys.some((key) => key.credentialId === credentialId)) ?? null;
}

async function updateUser(updated: UserRecord): Promise<void> {
  await saveUser(updated);
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
    return 'invalid email';
  }
  return null;
}

function validateUsername(username: string): string | null {
  const value = username.trim();
  if (value.length < 2 || value.length > 20) {
    return 'username must be 2-20 chars';
  }
  return null;
}

function validatePassword(password: string): string | null {
  if (password.length < 8) {
    return 'password must be at least 8 chars';
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
    throw new Error(emailError ?? usernameError ?? passwordError ?? 'incomplete info');
  }

  const existing = await findUserByIdentifier(email);
  if (existing) throw new Error('email already registered');
  const existingByName = await findUserByIdentifier(username);
  if (existingByName) throw new Error('username already taken');

  const user: UserRecord = {
    id: randomUUID(),
    email,
    username,
    passwordHash: hashPassword(input.password),
    avatar: null,
    passkeys: [],
    createdAt: Date.now(),
  };
  await saveUser(user);

  const token = await createSession(user.id);
  return { user: toPublicUser(user), token };
}

export async function loginWithPassword(
  identifier: string,
  password: string,
): Promise<{ user: PublicUser; token: string }> {
  const user = await findUserByIdentifier(identifier);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw new Error('wrong credentials');
  }
  const token = await createSession(user.id);
  return { user: toPublicUser(user), token };
}

async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const rec: SessionRecord = { userId, expiresAt: Date.now() + SESSION_TTL_MS };
  await saveSession(token, rec);
  return token;
}

export async function resolveSession(token: string): Promise<UserRecord | null> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase
      .from('sessions')
      .select('user_id, expires_at')
      .eq('token', token)
      .maybeSingle();
    if (!error && data) {
      const expiresAt = Number(data.expires_at) || 0;
      if (expiresAt < Date.now()) {
        await deleteSessionFromStore(token);
        return null;
      }
      return findUserById(data.user_id as string);
    }
    return null;
  }
  const sessions = await loadSessions();
  const session = sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete sessions[token];
    await saveSessions(sessions);
    return null;
  }
  return findUserById(session.userId);
}

export async function deleteSession(token: string): Promise<void> {
  await deleteSessionFromStore(token);
}

export async function updateProfile(
  userId: string,
  input: { username?: string; email?: string; avatar?: string | null },
): Promise<PublicUser> {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error('user not found');
  }

  if (input.username !== undefined) {
    const username = input.username.trim();
    const error = validateUsername(username);
    if (error) throw new Error(error);
    const supabase = getSupabase();
    let conflict: UserRecord | null = null;
    if (supabase) {
      const { data } = await supabase
        .from('users')
        .select('*')
        .ilike('username', username)
        .limit(1);
      conflict = data && data.length > 0 && (data[0] as Record<string, unknown>).id !== userId
        ? rowToUser(data[0] as Record<string, unknown>)
        : null;
    } else {
      const users = await loadUsers();
      conflict = users.find((item) => item.id !== userId && item.username.toLowerCase() === username.toLowerCase()) ?? null;
    }
    if (conflict) throw new Error('username already taken');
    user.username = username;
  }

  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    const error = validateEmail(email);
    if (error) throw new Error(error);
    const supabase = getSupabase();
    let conflict: UserRecord | null = null;
    if (supabase) {
      const { data } = await supabase.from('users').select('*').eq('email', email).limit(1);
      conflict = data && data.length > 0 && (data[0] as Record<string, unknown>).id !== userId
        ? rowToUser(data[0] as Record<string, unknown>)
        : null;
    } else {
      const users = await loadUsers();
      conflict = users.find((item) => item.id !== userId && item.email.toLowerCase() === email) ?? null;
    }
    if (conflict) throw new Error('email already used');
    user.email = email;
  }

  if (input.avatar !== undefined) {
    if (input.avatar && !/^data:image\/(png|jpe?g|webp);base64,/i.test(input.avatar)) {
      throw new Error('avatar format not supported');
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
  /** 当前请求持有、需要保留的会话；其余会话一律踢掉 */
  keepToken?: string,
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw new Error('user not found');
  if (user.passwordHash && !verifyPassword(currentPassword, user.passwordHash)) {
    throw new Error('wrong current password');
  }
  const error = validatePassword(newPassword);
  if (error) throw new Error(error);
  user.passwordHash = hashPassword(newPassword);
  await updateUser(user);
  if (keepToken) {
    // 改密码后旧会话必须失效，否则密码泄漏时「改了也没用」
    await deleteOtherSessions(userId, keepToken);
  }
}

/** 删除某个用户除 `keepToken` 之外的所有会话，返回删除条数。 */
export async function deleteOtherSessions(userId: string, keepToken: string): Promise<number> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase
      .from('sessions')
      .delete()
      .eq('user_id', userId)
      .neq('token', keepToken)
      .select('token');
    if (error) {
      throw new Error(error.message);
    }
    return Array.isArray(data) ? data.length : 0;
  }
  const sessions = await loadSessions();
  let removed = 0;
  for (const [token, record] of Object.entries(sessions)) {
    if (record.userId === userId && token !== keepToken) {
      delete sessions[token];
      removed += 1;
    }
  }
  if (removed > 0) {
    await saveSessions(sessions);
  }
  return removed;
}

export async function passkeyRegistrationOptions(
  user: UserRecord,
  rpID: string,
): Promise<Record<string, unknown>> {
  const options = await generateRegistrationOptions({
    rpName: 'Huiyuan · KNOWLEDGE SPACE',
    rpID,
    userName: user.email,
    userID: createHash('sha256').update(user.id).digest(),
    userDisplayName: user.username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      // 与 verifyRegistrationResponse 的 requireUserVerification 保持一致，
      // 否则部分只能做「用户在场」的认证器会注册失败
      userVerification: 'required',
    },
    excludeCredentials: user.passkeys.map((key) => ({
      id: key.credentialId,
      transports: key.transports,
    })),
  });
  await saveChallenge('register', options.challenge, user.id);
  return options as unknown as Record<string, unknown>;
}

export async function verifyPasskeyRegistration(
  user: UserRecord,
  response: RegistrationResponseJSON,
  origin: string,
  rpID: string,
): Promise<void> {
  const record = await takeChallenge(challengeFromResponse(response), 'register');
  if (record.userId !== user.id) {
    throw new Error('passkey 注册会话与当前账号不匹配，请重试');
  }
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: record.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('passkey verification failed');
  }
  const { credential } = verification.registrationInfo;
  if (user.passkeys.some((key) => key.credentialId === credential.id)) {
    throw new Error('passkey already registered');
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
  if (!user) throw new Error('user not found');
  user.passkeys = [];
  await updateUser(user);
}

export async function passkeyAuthenticationOptions(rpID: string): Promise<Record<string, unknown>> {
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
  });
  await saveChallenge('login', options.challenge, null);
  return options as unknown as Record<string, unknown>;
}

export async function verifyPasskeyAuthentication(
  response: AuthenticationResponseJSON,
  origin: string,
  rpID: string,
): Promise<{ user: PublicUser; token: string }> {
  const user = await findUserByCredentialId(response.id);
  if (!user) throw new Error('no user found for this passkey');
  const key = user.passkeys.find((item) => item.credentialId === response.id);
  if (!key) throw new Error('passkey credential invalid');
  const record = await takeChallenge(challengeFromResponse(response), 'login');
  const credential: WebAuthnCredential = {
    id: key.credentialId,
    publicKey: fromB64url(key.publicKey),
    counter: key.counter,
    transports: key.transports,
  };
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: record.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
    requireUserVerification: true,
  });
  if (!verification.verified) {
    throw new Error('passkey verification failed');
  }
  key.counter = verification.authenticationInfo.newCounter;
  await updateUser(user);
  const token = await createSession(user.id);
  return { user: toPublicUser(user), token };
}

export function isAuthCloud(): boolean {
  return isSupabaseConfigured();
}