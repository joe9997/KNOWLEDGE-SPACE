import type { NextFunction, Request, Response } from 'express';

/**
 * 极简滑动窗口限流。
 *
 * 说明：计数在进程内存里，单实例够用；部署成多实例（Vercel）后每个实例各算一份，
 * 只能挡住「同一实例上的暴力破解」，真正的配额要换成 Redis / Supabase 计数。
 * 但比完全没有强：现在登录、注册、AI 接口都是零限制。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 20_000;

function sweep(now: number): void {
  if (buckets.size < MAX_BUCKETS) {
    return;
  }
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** 计数维度，默认按来源 IP */
  key?: (req: Request) => string;
  message?: string;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, message } = options;
  const keyOf = options.key ?? ((req: Request) => req.ip ?? 'unknown');

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    sweep(now);
    const key = `${keyOf(req)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(max - 1));
      next();
      return;
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: message ?? `请求过于频繁，请 ${retryAfter} 秒后再试。` });
      return;
    }
    next();
  };
}
