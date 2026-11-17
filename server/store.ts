import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export interface StoredDoc {
  id: string;
  title: string;
  text: string;
  origin: string;
  createdAt: number;
  updatedAt: number;
  nodes: StoredNode[];
  relations: StoredRelation[];
}

export interface Snapshot {
  docs: StoredDoc[];
  activeDocId: string | null;
  updatedAt: number;
}

const MAX_DOCS = 500;
const MAX_NODES = 2000;
const MAX_TEXT = 500_000;

const dataDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
);

/** 每个用户一份知识数据文件，避免互相串数据 */
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

function sanitizeDoc(raw: unknown): StoredDoc | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const doc = raw as Record<string, unknown>;
  const id = str(doc.id);
  if (!id) {
    return null;
  }
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
    title: str(doc.title, '未命名材料').slice(0, 200),
    text: str(doc.text).slice(0, MAX_TEXT),
    origin: str(doc.origin, 'local'),
    createdAt: num(doc.createdAt, Date.now()),
    updatedAt: num(doc.updatedAt, Date.now()),
    nodes,
    relations,
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

export async function readSnapshot(userId: string): Promise<Snapshot> {
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

// 串行写入 + 临时文件替换，避免并发写坏数据文件
let writeQueue: Promise<void> = Promise.resolve();

export function writeSnapshot(userId: string, snapshot: Snapshot): Promise<void> {
  const payload = JSON.stringify(snapshot, null, 2);
  writeQueue = writeQueue
    .then(async () => {
      const file = dataFileFor(userId);
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, payload, 'utf8');
      await rename(temp, file);
    })
    .catch((error: unknown) => {
      console.warn(`[store] 写入失败 · ${error instanceof Error ? error.message : String(error)}`);
    });
  return writeQueue;
}
