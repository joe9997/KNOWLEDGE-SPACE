import type { KnowledgeDoc } from './types';

export interface RemoteSnapshot {
  docs: KnowledgeDoc[];
  activeDocId: string | null;
  updatedAt: number;
}

export async function fetchSnapshot(): Promise<RemoteSnapshot | null> {
  try {
    const response = await fetch('/api/data', { headers: { Accept: 'application/json' } });
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
    const response = await fetch('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs, activeDocId }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
