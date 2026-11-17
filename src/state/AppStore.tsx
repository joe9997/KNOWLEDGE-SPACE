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
  setOffsetDays: (days: number) => void;
  setActiveDocId: (id: string) => void;
  createDoc: (input: CreateDocInput) => string;
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

export function AppProvider({ children }: { children: ReactNode }) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>(initialDocs);
  const [storedActiveId, setStoredActiveId] = useState<string | null>(() => loadActiveDocId());
  const [offsetDays, setOffsetDays] = useState(0);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(() => loadApiConfig());

  const activeDoc = useMemo(() => {
    return docs.find((doc) => doc.id === storedActiveId) ?? docs[0] ?? null;
  }, [docs, storedActiveId]);

  const activeDocId = activeDoc?.id ?? null;

  useEffect(() => {
    saveDocs(docs);
  }, [docs]);

  useEffect(() => {
    saveActiveDocId(activeDocId);
  }, [activeDocId]);

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
      setOffsetDays,
      setActiveDocId,
      createDoc,
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
      setActiveDocId,
      createDoc,
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
