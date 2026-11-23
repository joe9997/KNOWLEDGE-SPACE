import { apiFetch } from './auth';
import type { KnowledgeDoc } from './types';

export interface RemoteSnapshot {
  docs: KnowledgeDoc[];
  activeDocId: string | null;
  updatedAt: number;
}

export async function fetchSnapshot(): Promise<RemoteSnapshot | null> {
  try {
    const response = await apiFetch('/api/data', { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as Partial<RemoteSnapshot>;
    if (!Array.isArray(data.docs)) {
      return null;
    }
    return {
      docs: data.docs,
      activeDocId: typeof data.activeDocId === 'string' ? data.activeDocId : null,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function pushSnapshot(
  docs: KnowledgeDoc[],
  activeDocId: string | null,
): Promise<boolean> {
  try {
    const response = await apiFetch('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs, activeDocId }),
    });
    if (!response.ok) {
      // 以前这里静默返回 false，云端写入失败用户完全无感。
      const detail = await response.text().catch(() => '');
      console.warn(`[sync] 云端保存失败 · HTTP ${response.status} ${detail.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[sync] 云端保存失败 · ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
