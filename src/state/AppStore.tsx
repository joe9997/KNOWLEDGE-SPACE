import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { createDemoDoc, DEMO_DOC_ID } from '../data/demo';
import { createId } from '../lib/id';
import { DAY_MS, scheduleReview } from '../lib/review';
import {
  clearApiConfig,
  loadActiveDocId,
  loadApiConfig,
  loadDocs,
  saveActiveDocId,
  saveApiConfig,
  saveDocs,
} from '../lib/storage';
import type {
  ApiConfig,
  DocOrigin,
  KnowledgeDoc,
  KnowledgeNode,
  ReviewGrade,
} from '../lib/types';
import { validateApiConfig } from '../lib/llm';
import { fetchSnapshot, pushSnapshot } from '../lib/persistence';
import { getServerAiStatus } from '../lib/serverAi';
import type { ServerAiStatus } from '../lib/serverAi';

interface CreateDocInput {
  title: string;
  text: string;
  origin: DocOrigin;
  nodes: KnowledgeNode[];
}

interface AppContextValue {
  docs: KnowledgeDoc[];
  activeDoc: KnowledgeDoc | null;
  activeDocId: string | null;
  now: number;
  offsetDays: number;
  apiConfig: ApiConfig | null;
  apiReady: boolean;
  serverAi: ServerAiStatus | null;
  aiReady: boolean;
  refreshServerAi: () => Promise<void>;
  setOffsetDays: (days: number) => void;
  setActiveDocId: (id: string) => void;
  createDoc: (input: CreateDocInput) => string;
  renameDoc: (id: string, title: string) => void;
  deleteDoc: (id: string) => void;
  reviewNode: (docId: string, nodeId: string, grade: ReviewGrade) => void;
  resetDemo: () => string;
  updateApiConfig: (config: ApiConfig | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function initialDocs(): KnowledgeDoc[] {
  const stored = loadDocs();
  if (stored && stored.length > 0) {
    return stored;
  }
  return [createDemoDoc()];
}

/** 合并本地与服务端数据：同一会话取 updatedAt 较新的版本 */
function mergeDocs(remote: KnowledgeDoc[], local: KnowledgeDoc[]): KnowledgeDoc[] {
  const byId = new Map(remote.map((doc) => [doc.id, doc]));
  for (const doc of local) {
    const existing = byId.get(doc.id);
    if (!existing || doc.updatedAt > existing.updatedAt) {
      byId.set(doc.id, doc);
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>(initialDocs);
  const [storedActiveId, setStoredActiveId] = useState<string | null>(() => loadActiveDocId());
  const [offsetDays, setOffsetDays] = useState(0);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(() => loadApiConfig());
  const [serverAi, setServerAi] = useState<ServerAiStatus | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const refreshServerAi = useCallback(async () => {
    try {
      setServerAi(await getServerAiStatus());
    } catch {
      setServerAi({ reachable: false, available: false, model: null, baseUrl: null });
    }
  }, []);

  useEffect(() => {
    void refreshServerAi();
  }, [refreshServerAi]);

  const activeDoc = useMemo(() => {
    return docs.find((doc) => doc.id === storedActiveId) ?? docs[0] ?? null;
  }, [docs, storedActiveId]);

  const activeDocId = activeDoc?.id ?? null;

  // 从服务端数据库读取一次，与本地缓存合并，之后以较新的版本为准
  useEffect(() => {
    let alive = true;
    void (async () => {
      const remote = await fetchSnapshot();
      if (!alive) {
        return;
      }
      if (remote && remote.docs.length > 0) {
        setDocs((local) => mergeDocs(remote.docs, local));
        if (remote.activeDocId) {
          setStoredActiveId(remote.activeDocId);
        }
      }
      setHydrated(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    saveDocs(docs);
    saveActiveDocId(activeDocId);
  }, [docs, activeDocId]);

  // 防抖写回服务端数据库；后端不可用时仍保留 localStorage 兜底
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    const timer = window.setTimeout(() => {
      void pushSnapshot(docs, activeDocId);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [docs, activeDocId, hydrated]);

  const setActiveDocId = useCallback((id: string) => {
    setStoredActiveId(id);
  }, []);

  const createDoc = useCallback((input: CreateDocInput) => {
    const id = createId('doc');
    const now = Date.now();
    const doc: KnowledgeDoc = {
      id,
      title: input.title.trim() || '未命名材料',
      text: input.text,
      origin: input.origin,
      createdAt: now,
      updatedAt: now,
      nodes: input.nodes,
      relations: [],
    };
    setDocs((prev) => [doc, ...prev]);
    setStoredActiveId(id);
    return id;
  }, []);

  const renameDoc = useCallback((id: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }
    setDocs((prev) =>
      prev.map((doc) =>
        doc.id === id ? { ...doc, title: nextTitle, updatedAt: Date.now() } : doc,
      ),
    );
  }, []);

  const deleteDoc = useCallback(
    (id: string) => {
      setDocs((prev) => prev.filter((doc) => doc.id !== id));
      if (activeDoc?.id === id) {
        const next = docs.find((doc) => doc.id !== id);
        setStoredActiveId(next?.id ?? null);
      }
    },
    [activeDoc, docs],
  );

  const reviewNode = useCallback(
    (docId: string, nodeId: string, grade: ReviewGrade) => {
      const now = Date.now() + offsetDays * DAY_MS;
      setDocs((prev) =>
        prev.map((doc) => {
          if (doc.id !== docId) {
            return doc;
          }
          return {
            ...doc,
            updatedAt: Date.now(),
            nodes: doc.nodes.map((node) => {
              if (node.id !== nodeId) {
                return node;
              }
              const schedule = scheduleReview(node, grade, now);
              return {
                ...node,
                mastery: schedule.mastery,
                goodStreak: schedule.goodStreak,
                lastReviewedAt: now,
                nextReviewAt: schedule.nextReviewAt,
              };
            }),
          };
        }),
      );
    },
    [offsetDays],
  );

  const resetDemo = useCallback(() => {
    const demo = createDemoDoc();
    setDocs((prev) => {
      const exists = prev.some((doc) => doc.id === DEMO_DOC_ID);
      return exists
        ? prev.map((doc) => (doc.id === DEMO_DOC_ID ? demo : doc))
        : [demo, ...prev];
    });
    setStoredActiveId(DEMO_DOC_ID);
    setOffsetDays(0);
    return DEMO_DOC_ID;
  }, []);

  const updateApiConfig = useCallback((config: ApiConfig | null) => {
    setApiConfig(config);
    if (config) {
      saveApiConfig(config);
    } else {
      clearApiConfig();
    }
  }, []);

  const apiReady = apiConfig !== null && validateApiConfig(apiConfig).ok;
  const serverAiReady = serverAi?.available === true;
  const aiReady = serverAiReady || apiReady;
  const now = Date.now() + offsetDays * DAY_MS;

  const value = useMemo<AppContextValue>(
    () => ({
      docs,
      activeDoc,
      activeDocId,
      now,
      offsetDays,
      apiConfig,
      apiReady,
      serverAi,
      aiReady,
      refreshServerAi,
      setOffsetDays,
      setActiveDocId,
      createDoc,
      renameDoc,
      deleteDoc,
      reviewNode,
      resetDemo,
      updateApiConfig,
    }),
    [
      docs,
      activeDoc,
      activeDocId,
      now,
      offsetDays,
      apiConfig,
      apiReady,
      serverAi,
      aiReady,
      refreshServerAi,
      setActiveDocId,
      createDoc,
      renameDoc,
      deleteDoc,
      reviewNode,
      resetDemo,
      updateApiConfig,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return value;
}
