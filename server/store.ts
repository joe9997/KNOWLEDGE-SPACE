import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSupabase, isSupabaseConfigured } from './supabase.js';

export interface StoredNode {
  id: string;
  title: string;
  question: string;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  parentId: string | null;
  level: number;
  mastery: number;
  goodStreak: number;
  lastReviewedAt: number | null;
  nextReviewAt: number;
}

export interface StoredRelation {
  from: string;
  to: string;
}

export interface StoredAnnotation {
  id: string;
  start: number;
  end: number;
  quote: string;
  note: string;
  createdAt: number;
}

export interface StoredDoc {
  id: string;
  title: string;
  text: string;
  origin: string;
  createdAt: number;
  updatedAt: number;
  nodes: StoredNode[];
  relations: StoredRelation[];
  annotations: StoredAnnotation[];
}

export interface Snapshot {
  docs: StoredDoc[];
  activeDocId: string | null;
  updatedAt: number;
}

const MAX_DOCS = 500;
const MAX_NODES = 2000;
const MAX_RELATIONS = 5000;
const MAX_TEXT = 500_000;
const MAX_ANNOTATIONS = 500;
const MAX_ANNOTATION_NOTE = 2000;

/** 存储层错误：带 HTTP 状态码和内部细节；对外只回一句人话，细节进日志。 */
export class StoreError extends Error {
  readonly status = 503;
  readonly detail: string;

  constructor(detail: string) {
    super('数据存储暂时不可用，请稍后重试。');
    this.detail = detail;
  }
}

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'data',
    );

function dataFileFor(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dataDir, 'users', `${safe}.json`);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeNode(raw: unknown): StoredNode | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const node = raw as Record<string, unknown>;
  const id = str(node.id);
  if (!id) {
    return null;
  }
  return {
    id,
    title: str(node.title),
    question: str(node.question),
    quote: str(node.quote),
    quoteStart: num(node.quoteStart, -1),
    quoteEnd: num(node.quoteEnd, -1),
    parentId: typeof node.parentId === 'string' ? node.parentId : null,
    level: num(node.level, 1),
    mastery: num(node.mastery),
    goodStreak: num(node.goodStreak),
    lastReviewedAt: nullableNum(node.lastReviewedAt),
    nextReviewAt: num(node.nextReviewAt),
  };
}

function sanitizeAnnotation(raw: unknown, textLength: number): StoredAnnotation | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const id = str(item.id);
  const start = num(item.start, -1);
  const end = num(item.end, -1);
  const note = str(item.note).trim();
  if (!id || !note || start < 0 || end <= start || end > textLength) {
    return null;
  }
  return {
    id,
    start,
    end,
    quote: str(item.quote).slice(0, 2000),
    note: note.slice(0, MAX_ANNOTATION_NOTE),
    createdAt: num(item.createdAt, Date.now()),
  };
}

function sanitizeDoc(raw: unknown): StoredDoc | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const doc = raw as Record<string, unknown>;
  const id = str(doc.id);
  if (!id) {
    return null;
  }
  const text = str(doc.text).slice(0, MAX_TEXT);
  const annotations = Array.isArray(doc.annotations)
    ? doc.annotations
        .slice(0, MAX_ANNOTATIONS)
        .map((item) => sanitizeAnnotation(item, text.length))
        .filter((item): item is StoredAnnotation => item !== null)
    : [];
  const nodes = Array.isArray(doc.nodes)
    ? doc.nodes
        .slice(0, MAX_NODES)
        .map(sanitizeNode)
        .filter((node): node is StoredNode => node !== null)
    : [];
  const relations = Array.isArray(doc.relations)
    ? doc.relations
        .filter(
          (item): item is StoredRelation =>
            Boolean(item) &&
            typeof (item as StoredRelation).from === 'string' &&
            typeof (item as StoredRelation).to === 'string',
        )
        .map((item) => ({ from: item.from, to: item.to }))
    : [];
  return {
    id,
    title: str(doc.title, 'untitled').slice(0, 200),
    text,
    origin: str(doc.origin, 'local'),
    createdAt: num(doc.createdAt, Date.now()),
    updatedAt: num(doc.updatedAt, Date.now()),
    nodes,
    relations,
    annotations,
  };
}

export function sanitizeDocs(raw: unknown): StoredDoc[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  return raw
    .slice(0, MAX_DOCS)
    .map(sanitizeDoc)
    .filter((doc): doc is StoredDoc => doc !== null);
}

/**
 * 写入前的边界检查。
 * 旧实现是「超限直接 slice，然后回 200」——用户会以为存上了，实际数据被悄悄截断。
 * 现在超限直接报错，由前端决定是拆分还是删会话。
 */
export function validateDocsPayload(raw: unknown): string | null {
  if (!Array.isArray(raw)) {
    return 'docs 必须是数组。';
  }
  if (raw.length > MAX_DOCS) {
    return `会话数量超过上限（${MAX_DOCS} 个，当前 ${raw.length} 个），请先删除一些旧会话。`;
  }
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return 'docs 中存在无效的会话对象。';
    }
    const doc = item as Record<string, unknown>;
    if (typeof doc.id !== 'string' || !doc.id) {
      return '每个会话都必须带有 id。';
    }
    const title = typeof doc.title === 'string' && doc.title ? doc.title : doc.id;
    const text = typeof doc.text === 'string' ? doc.text : '';
    if (text.length > MAX_TEXT) {
      return `会话「${title}」正文 ${text.length} 字，超过单篇上限 ${MAX_TEXT} 字，请拆分后再保存。`;
    }
    if (Array.isArray(doc.nodes) && doc.nodes.length > MAX_NODES) {
      return `会话「${title}」节点数 ${doc.nodes.length} 超过上限 ${MAX_NODES} 个。`;
    }
    if (Array.isArray(doc.relations) && doc.relations.length > MAX_RELATIONS) {
      return `会话「${title}」关系数 ${doc.relations.length} 超过上限 ${MAX_RELATIONS} 条。`;
    }
    if (Array.isArray(doc.annotations)) {
      if (doc.annotations.length > MAX_ANNOTATIONS) {
        return `会话「${title}」批注数 ${doc.annotations.length} 超过上限 ${MAX_ANNOTATIONS} 条。`;
      }
      for (const item of doc.annotations) {
        if (!item || typeof item !== 'object') {
          return `会话「${title}」中存在无效批注。`;
        }
        const annotation = item as Record<string, unknown>;
        const note = typeof annotation.note === 'string' ? annotation.note : '';
        const start = typeof annotation.start === 'number' ? annotation.start : -1;
        const end = typeof annotation.end === 'number' ? annotation.end : -1;
        if (note.length > MAX_ANNOTATION_NOTE) {
          return `会话「${title}」有批注超过 ${MAX_ANNOTATION_NOTE} 字上限。`;
        }
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) {
          return `会话「${title}」中存在范围无效的批注。`;
        }
      }
    }
  }
  return null;
}

async function readSnapshotFromFile(userId: string): Promise<Snapshot> {
  try {
    const raw = await readFile(dataFileFor(userId), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      docs: sanitizeDocs(parsed.docs) ?? [],
      activeDocId: typeof parsed.activeDocId === 'string' ? parsed.activeDocId : null,
      updatedAt: num(parsed.updatedAt),
    };
  } catch {
    return { docs: [], activeDocId: null, updatedAt: 0 };
  }
}

async function writeSnapshotToFile(userId: string, snapshot: Snapshot): Promise<void> {
  const payload = JSON.stringify(snapshot, null, 2);
  const file = dataFileFor(userId);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, payload, 'utf8');
  await rename(temp, file);
}

export async function readSnapshot(userId: string): Promise<Snapshot> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase
      .from('snapshots')
      .select('docs, active_doc_id, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      // 云端是唯一事实来源：读失败就明确报错，让前端继续用 localStorage，
      // 而不是回一份本地旧文件、随后又用它覆盖云端。
      throw new StoreError(`[store] read snapshot failed: ${error.message}`);
    }
    if (!data) {
      return { docs: [], activeDocId: null, updatedAt: 0 };
    }
    const docs = sanitizeDocs((data as Record<string, unknown>).docs) ?? [];
    return {
      docs,
      activeDocId: typeof (data as Record<string, unknown>).active_doc_id === 'string'
        ? ((data as Record<string, unknown>).active_doc_id as string)
        : null,
      updatedAt: num((data as Record<string, unknown>).updated_at),
    };
  }
  return readSnapshotFromFile(userId);
}

let writeQueue: Promise<void> = Promise.resolve();

async function writeSnapshotToStore(userId: string, snapshot: Snapshot): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) {
    await writeSnapshotToFile(userId, snapshot);
    return;
  }
  const { docs, activeDocId, updatedAt } = snapshot;
  const { error } = await supabase
    .from('snapshots')
    .upsert(
      { user_id: userId, docs, active_doc_id: activeDocId, updated_at: updatedAt },
      { onConflict: 'user_id' },
    );
  if (error) {
    throw new StoreError(`[store] upsert snapshot failed: ${error.message}`);
  }
}

/**
 * 同一个用户的数据按顺序写，避免并发 PUT 互相覆盖。
 * 注意：错误必须回传给调用方（旧实现把 catch 吞掉了，接口照样 200），
 * 所以这里把队列自身和返回的 Promise 分开维护。
 */
export function writeSnapshot(userId: string, snapshot: Snapshot): Promise<void> {
  const task = writeQueue.then(() => writeSnapshotToStore(userId, snapshot));
  writeQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export function isStoreCloud(): boolean {
  return isSupabaseConfigured();
}