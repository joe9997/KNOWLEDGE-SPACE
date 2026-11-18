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
  apiChangePassword,
  apiLogin,
  apiLogout,
  apiMe,
  apiRegister,
  apiUpdateProfile,
  loginWithPasskey,
} from '../lib/auth';
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
  User,
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
  currentUser: User | null;
  authLoading: boolean;
  refreshServerAi: () => Promise<void>;
  setOffsetDays: (days: number) => void;
  setActiveDocId: (id: string) => void;
  createDoc: (input: CreateDocInput) => string;
  renameDoc: (id: string, title: string) => void;
  deleteDoc: (id: string) => void;
  reviewNode: (docId: string, nodeId: string, grade: ReviewGrade) => void;
  resetDemo: () => string;
  updateApiConfig: (config: ApiConfig | null) => void;
  login: (identifier: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  loginWithPasskey: () => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (input: { username?: string; email?: string; avatar?: string | null }) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

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
  const [docs, setDocs] = useState<KnowledgeDoc[]>(() => [createDemoDoc()]);
  const [storedActiveId, setStoredActiveId] = useState<string | null>(null);
  const [offsetDays, setOffsetDays] = useState(0);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const [serverAi, setServerAi] = useState<ServerAiStatus | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
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

  /** 登录成功后加载该用户的数据：本地缓存 + 服务端数据库 */
  const applyUser = useCallback(async (user: User) => {
    setCurrentUser(user);
    setApiConfig(loadApiConfig(user.id));
    const local = loadDocs(user.id) ?? [];
    const remote = await fetchSnapshot();
    let next = local;
    if (remote && remote.docs.length > 0) {
      next = mergeDocs(remote.docs, local);
    }
    if (next.length === 0) {
      next = [createDemoDoc()];
    }
    setDocs(next);
    const activeId = remote?.activeDocId ?? loadActiveDocId(user.id) ?? next[0]?.id ?? null;
    setStoredActiveId(activeId);
    setHydrated(true);
  }, []);

  const clearUser = useCallback(() => {
    setCurrentUser(null);
    setApiConfig(null);
    setDocs([createDemoDoc()]);
    setStoredActiveId(null);
    setHydrated(false);
  }, []);

  // 启动时恢复会话
  useEffect(() => {
    let alive = true;
    void (async () => {
      const user = await apiMe();
      if (!alive) {
        return;
      }
      if (user) {
        await applyUser(user);
      }
      setAuthLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [applyUser]);

  // 按用户落本地缓存
  useEffect(() => {
    if (!currentUser) {
      return;
    }
    saveDocs(currentUser.id, docs);
    saveActiveDocId(currentUser.id, activeDocId);
  }, [docs, activeDocId, currentUser]);

  // 防抖写回服务端数据库；后端不可用时仍保留 localStorage 兜底
  useEffect(() => {
    if (!currentUser || !hydrated) {
      return;
    }
    const timer = window.setTimeout(() => {
      void pushSnapshot(docs, activeDocId);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [docs, activeDocId, currentUser, hydrated]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const { user } = await apiLogin(identifier, password);
      await applyUser(user);
    },
    [applyUser],
  );

  const register = useCallback(
    async (email: string, username: string, password: string) => {
      const { user } = await apiRegister({ email, username, password });
      await applyUser(user);
    },
    [applyUser],
  );

  const loginWithPasskeyFn = useCallback(async () => {
    const { user } = await loginWithPasskey();
    await applyUser(user);
  }, [applyUser]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      clearUser();
    }
  }, [clearUser]);

  const updateProfile = useCallback(
    async (input: { username?: string; email?: string; avatar?: string | null }) => {
      const user = await apiUpdateProfile(input);
      setCurrentUser(user);
    },
    [],
  );

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await apiChangePassword(currentPassword, newPassword);
  }, []);

  const refreshUser = useCallback(async () => {
    const user = await apiMe();
    if (user) {
      setCurrentUser(user);
    }
  }, []);

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

  const updateApiConfig = useCallback(
    (config: ApiConfig | null) => {
      setApiConfig(config);
      if (currentUser) {
        if (config) {
          saveApiConfig(currentUser.id, config);
        } else {
          clearApiConfig(currentUser.id);
        }
      }
    },
    [currentUser],
  );

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
      currentUser,
      authLoading,
      refreshServerAi,
      setOffsetDays,
      setActiveDocId,
      createDoc,
      renameDoc,
      deleteDoc,
      reviewNode,
      resetDemo,
      updateApiConfig,
      login,
      register,
      loginWithPasskey: loginWithPasskeyFn,
      logout,
      updateProfile,
      changePassword,
      refreshUser,
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
      currentUser,
      authLoading,
      refreshServerAi,
      setActiveDocId,
      createDoc,
      renameDoc,
      deleteDoc,
      reviewNode,
      resetDemo,
      updateApiConfig,
      login,
      register,
      loginWithPasskeyFn,
      logout,
      updateProfile,
      changePassword,
      refreshUser,
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
