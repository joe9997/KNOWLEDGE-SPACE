import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { getSupabase } from './supabase.js';

/**
 * WebAuthn challenge 存储。
 *
 * 之前 challenge 放在模块级变量里（`let pendingLogin`），有两个硬伤：
 * 1. 全局单例：两个用户同时登录时后一个会覆盖前一个的 challenge；
 * 2. 进程内存：Vercel / 多实例部署时，发 challenge 和验 challenge 可能落在不同实例上，必然失败。
 *
 * 这里改成「按 challenge 值存一条记录、验证时取走并删除」：
 * - 配了 Supabase 就存表 `webauthn_challenges`；
 * - 没配就存 `data/challenges.json`（同一台机器的多进程仍然不共享，生产请用 Supabase）。
 * 客户端不需要改：challenge 值本来就在 `clientDataJSON` 里。
 */

export type ChallengePurpose = 'register' | 'login';

export interface ChallengeRecord {
  challenge: string;
  purpose: ChallengePurpose;
  /** 注册时绑定用户；登录时为 null，认证通过后再和 credential 的归属校验。 */
  userId: string | null;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_LOCAL_RECORDS = 5000;

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const challengesFile = path.join(dataDir, 'challenges.json');

function isExpired(record: ChallengeRecord, now = Date.now()): boolean {
  return !Number.isFinite(record.expiresAt) || record.expiresAt <= now;
}

/** 本地文件读改写串行化，避免并发注册/登录互相覆盖。 */
let localQueue: Promise<unknown> = Promise.resolve();

function enqueueLocal<T>(task: () => Promise<T>): Promise<T> {
  const run = localQueue.then(task, task);
  localQueue = run.catch(() => undefined);
  return run;
}

async function readLocal(): Promise<Record<string, ChallengeRecord>> {
  try {
    const raw = await readFile(challengesFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, ChallengeRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLocal(records: Record<string, ChallengeRecord>): Promise<void> {
  const now = Date.now();
  const kept: Record<string, ChallengeRecord> = {};
  for (const [key, record] of Object.entries(records)) {
    if (!isExpired(record, now)) {
      kept[key] = record;
    }
  }
  await mkdir(dataDir, { recursive: true });
  const temp = `${challengesFile}.tmp`;
  await writeFile(temp, JSON.stringify(kept, null, 2), 'utf8');
  await rename(temp, challengesFile);
}

/** 保存一条 challenge；写失败直接抛错，不允许「看起来发出去了其实没存」。 */
export async function saveChallenge(
  purpose: ChallengePurpose,
  challenge: string,
  userId: string | null = null,
): Promise<void> {
  if (!challenge) {
    throw new Error('无法生成 passkey challenge');
  }
  const record: ChallengeRecord = {
    challenge,
    purpose,
    userId,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase
      .from('webauthn_challenges')
      .upsert(
        {
          challenge: record.challenge,
          purpose: record.purpose,
          user_id: record.userId,
          expires_at: record.expiresAt,
        },
        { onConflict: 'challenge' },
      );
    if (error) {
      throw new Error(`保存 passkey challenge 失败：${error.message}`);
    }
    // 顺手清理过期记录；失败不影响主流程
    void supabase
      .from('webauthn_challenges')
      .delete()
      .lt('expires_at', Date.now())
      .then(() => undefined, () => undefined);
    return;
  }
  await enqueueLocal(async () => {
    const records = await readLocal();
    if (Object.keys(records).length >= MAX_LOCAL_RECORDS) {
      const now = Date.now();
      for (const [key, value] of Object.entries(records)) {
        if (isExpired(value, now)) {
          delete records[key];
        }
      }
    }
    records[record.challenge] = record;
    await writeLocal(records);
  });
}

/** 取出并删除一条 challenge；一次性使用，防止重放。 */
export async function takeChallenge(
  challenge: string,
  purpose: ChallengePurpose,
): Promise<ChallengeRecord> {
  const key = typeof challenge === 'string' ? challenge.trim() : '';
  if (!key) {
    throw new Error('passkey 响应缺少 challenge，请重新发起验证');
  }
  const supabase = getSupabase();
  let record: ChallengeRecord | null = null;

  if (supabase) {
    const { data, error } = await supabase
      .from('webauthn_challenges')
      .select('challenge, purpose, user_id, expires_at')
      .eq('challenge', key)
      .maybeSingle();
    if (error) {
      throw new Error(`读取 passkey challenge 失败：${error.message}`);
    }
    if (data) {
      const row = data as Record<string, unknown>;
      record = {
        challenge: String(row.challenge),
        purpose: row.purpose === 'register' ? 'register' : 'login',
        userId: typeof row.user_id === 'string' ? row.user_id : null,
        expiresAt: Number(row.expires_at) || 0,
      };
      await supabase.from('webauthn_challenges').delete().eq('challenge', key);
    }
  } else {
    record = await enqueueLocal(async () => {
      const records = await readLocal();
      const found = records[key] ?? null;
      if (found) {
        delete records[key];
        await writeLocal(records);
      }
      return found;
    });
  }

  if (!record) {
    throw new Error('passkey 验证会话不存在或已使用，请重试');
  }
  if (record.purpose !== purpose) {
    throw new Error('passkey 验证会话用途不匹配，请重试');
  }
  if (isExpired(record)) {
    throw new Error('passkey 验证会话已过期，请重试');
  }
  return record;
}

/**
 * 从 WebAuthn 响应里取出 challenge。
 * 浏览器的 `clientDataJSON` 是 base64url 编码的 JSON，`challenge` 字段就是服务端下发的原值。
 */
export function challengeFromResponse(
  response: RegistrationResponseJSON | AuthenticationResponseJSON | undefined,
): string {
  const raw = (response as { response?: { clientDataJSON?: unknown } } | undefined)?.response
    ?.clientDataJSON;
  if (typeof raw !== 'string' || !raw) {
    return '';
  }
  try {
    const data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    return typeof data.challenge === 'string' ? data.challenge : '';
  } catch {
    return '';
  }
}
