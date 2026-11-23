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
  resolveApiUrl,
} from '../lib/auth';
import {
  clearApiConfig,
  loadActiveDocId,
  loadApiConfig,
  loadDocs,
  loadLearningPrefs,
  saveActiveDocId,
  saveApiConfig,
  saveDocs,
  saveLearningPrefs,
} from '../lib/storage';
import { DEFAULT_PREFS, rhythmFactor } from '../lib/learningPrefs';
import type { LearningPrefs } from '../lib/learningPrefs';
import type {
  ApiConfig,
  DocOrigin,
  KnowledgeDoc,
  KnowledgeNode,
  ReviewGrade,
  SourceAnnotation,
  User,
} from '../lib/types';
import { validateApiConfig } from '../lib/llm';
import { normalizeAnnotationRange, overlapsAnnotation } from '../lib/annotations';
import { buildDocMeta, deriveNodeTitle, isWeakNodeTitle, rebuildLocalExplanation } from '../lib/localExtract';
import { fetchSnapshot, pushSnapshot } from '../lib/persistence';
import { getServerAiStatus } from '../lib/serverAi';
import type { ServerAiStatus } from '../lib/serverAi';

/** 本地模式使用的虚拟用户 id（数据只存浏览器，不参与云端同步） */
const LOCAL_USER_ID = 'local-device';

interface CreateDocInput {
  title: string;
  subtitle?: string;
  summary?: string;
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
  /** 后端可达性：null = 探测中，false = 后端不可用（纯静态托管，如 GitHub Pages） */
  backendAvailable: boolean | null;
  /** 不登录，直接用本地模式（数据只存浏览器 localStorage） */
  enterLocalMode: () => void;
  localMode: boolean;
  learningPrefs: LearningPrefs;
  updateLearningPrefs: (patch: Partial<LearningPrefs>) => void;
  refreshServerAi: () => Promise<void>;
  setOffsetDays: (days: number) => void;
  setActiveDocId: (id: string) => void;
  createDoc: (input: CreateDocInput) => string;
  renameDoc: (id: string, title: string) => void;
  deleteDoc: (id: string) => void;
  addAnnotation: (docId: string, input: { start: number; end: number; note: string }) => void;
  removeAnnotation: (docId: string, annotationId: string) => void;
  reviewNode: (docId: string, nodeId: string, grade: ReviewGrade) => void;
  updateNodeExplanations: (docId: string, explanations: Record<string, string>) => void;
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

/**
 * 旧文档的展示修正（只用于展示，不回写存储）：
 * - 没有副标题 / 摘要时用本地规则补一份
 * - 把 "However" / "In this section" 这类空标题换成从原文推导的标题
 */
function withAutoMeta(doc: KnowledgeDoc): KnowledgeDoc {
  const meta = doc.text && (!doc.subtitle || !doc.summary) ? buildDocMeta(doc.text) : null;
  const used = new Set<string>();
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    let title = node.title;
    let explanation = node.explanation;
    if (node.quote && isWeakNodeTitle(title)) {
      title = deriveNodeTitle(node.quote, title);
      changed = true;
      // 标题是弱标题，说明讲解也可能是旧算法生成的，一并重建
      explanation = rebuildLocalExplanation(title, node.quote);
    } else if (!explanation && node.quote) {
      explanation = rebuildLocalExplanation(title, node.quote);
      changed = true;
    }
    let unique = title;
    let suffix = 2;
    while (used.has(unique)) {
      unique = `${title} ${suffix}`;
      suffix += 1;
    }
    used.add(unique);
    if (unique === node.title && explanation === node.explanation) {
      return node;
    }
    return { ...node, title: unique, explanation };
  });

  if (!meta && !changed) {
    return doc;
  }
  return {
    ...doc,
    subtitle: doc.subtitle ?? meta?.subtitle,
    summary: doc.summary ?? meta?.summary,
    nodes,
  };
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
  const [docs, setDocs] = useState<KnowledgeDoc[]>(() => [createDemoDoc()]);
  const [storedActiveId, setStoredActiveId] = useState<string | null>(null);
  const [offsetDays, setOffsetDays] = useState(0);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const [serverAi, setServerAi] = useState<ServerAiStatus | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);
  const [localMode, setLocalMode] = useState(false);
  const [learningPrefs, setLearningPrefs] = useState<LearningPrefs>(DEFAULT_PREFS);
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
    setLocalMode(false);
    setApiConfig(loadApiConfig(user.id));
    setLearningPrefs(loadLearningPrefs(user.id));
    const local = loadDocs(user.id) ?? [];
    const remote = await fetchSnapshot();
    let next = local;
    if (remote && remote.docs.length > 0) {
      next = mergeDocs(remote.docs, local);
    }
    if (next.length === 0) {
      next = [createDemoDoc()];
    }
    setDocs(next.map(withAutoMeta));
    const activeId = remote?.activeDocId ?? loadActiveDocId(user.id) ?? next[0]?.id ?? null;
    setStoredActiveId(activeId);
    setHydrated(true);
  }, []);

  const clearUser = useCallback(() => {
    setCurrentUser(null);
    setLocalMode(false);
    setApiConfig(null);
    setDocs([createDemoDoc()]);
    setStoredActiveId(null);
    setHydrated(false);
  }, []);

  /** 后端不可用时（纯静态托管）跳过登录，直接用本地 localStorage */
  const enterLocalMode = useCallback(() => {
    const guest: User = {
      id: LOCAL_USER_ID,
      email: 'local@device',
      username: '本地用户',
      avatar: null,
      hasPassword: false,
      hasPasskey: false,
      createdAt: Date.now(),
    };
    void (async () => {
      setLocalMode(true);
      setCurrentUser(guest);
      setApiConfig(loadApiConfig(guest.id));
      setLearningPrefs(loadLearningPrefs(guest.id));
      const local = loadDocs(guest.id) ?? [];
      const next = local.length > 0 ? local : [createDemoDoc()];
      setDocs(next.map(withAutoMeta));
      setStoredActiveId(loadActiveDocId(guest.id) ?? next[0]?.id ?? null);
      setHydrated(true);
    })();
  }, []);

  // 探测后端是否可用：纯静态托管（GitHub Pages）时 /api/health 返回 404/405
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(resolveApiUrl('/api/health'), {
          headers: { Accept: 'application/json' },
        });
        if (!alive) return;
        setBackendAvailable(res.ok);
      } catch {
        if (alive) setBackendAvailable(false);
      }
    })();
    return () => {
      alive = false;
    };
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

  // 防抖写回服务端数据库；本地模式 / 后端不可用时只保留 localStorage
  useEffect(() => {
    if (!currentUser || !hydrated || localMode) {
      return;
    }
    const timer = window.setTimeout(() => {
      void pushSnapshot(docs, activeDocId);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [docs, activeDocId, currentUser, hydrated, localMode]);

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
      ...(input.subtitle?.trim() ? { subtitle: input.subtitle.trim() } : {}),
      ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
      text: input.text,
      origin: input.origin,
      createdAt: now,
      updatedAt: now,
      nodes: input.nodes,
      relations: [],
      annotations: [],
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

  const addAnnotation = useCallback(
    (docId: string, input: { start: number; end: number; note: string }) => {
      const note = input.note.trim();
      if (!note) {
        return;
      }
      setDocs((prev) =>
        prev.map((doc) => {
          if (doc.id !== docId) {
            return doc;
          }
          const range = normalizeAnnotationRange(doc.text, input.start, input.end);
          if (!range) {
            return doc;
          }
          const existing = doc.annotations ?? [];
          if (overlapsAnnotation(existing, range.start, range.end)) {
            return doc;
          }
          const annotation: SourceAnnotation = {
            id: createId('note'),
            start: range.start,
            end: range.end,
            quote: range.quote,
            note: note.slice(0, 2000),
            createdAt: Date.now(),
          };
          return {
            ...doc,
            updatedAt: Date.now(),
            annotations: [...existing, annotation],
          };
        }),
      );
    },
    [],
  );

  const removeAnnotation = useCallback((docId: string, annotationId: string) => {
    setDocs((prev) =>
      prev.map((doc) => {
        if (doc.id !== docId || !doc.annotations?.length) {
          return doc;
        }
        const next = doc.annotations.filter((item) => item.id !== annotationId);
        if (next.length === doc.annotations.length) {
          return doc;
        }
        return { ...doc, updatedAt: Date.now(), annotations: next };
      }),
    );
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
              const schedule = scheduleReview(node, grade, now, {
                baseDays: learningPrefs.baseDays,
                rhythmFactor: rhythmFactor(learningPrefs.rhythm),
              });
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
    [offsetDays, learningPrefs],
  );

  /** 后台用 AI 批量给节点补 explanation；不阻塞 UI，失败静默。 */
  const updateNodeExplanations = useCallback(
    (docId: string, explanations: Record<string, string>) => {
      const entries = Object.entries(explanations).filter(([, exp]) => exp && exp.trim());
      if (entries.length === 0) {
        return;
      }
      setDocs((prev) =>
        prev.map((doc) => {
          if (doc.id !== docId) {
            return doc;
          }
          const patch = new Map(entries);
          let touched = false;
          const nodes = doc.nodes.map((node) => {
            const exp = patch.get(node.id);
            if (!exp || node.explanation === exp) {
              return node;
            }
            touched = true;
            return { ...node, explanation: exp };
          });
          if (!touched) {
            return doc;
          }
          return { ...doc, nodes, updatedAt: Date.now() };
        }),
      );
    },
    [],
  );

  const updateLearningPrefs = useCallback(
    (patch: Partial<LearningPrefs>) => {
      setLearningPrefs((prev) => {
        const next = { ...prev, ...patch };
        if (currentUser) {
          saveLearningPrefs(currentUser.id, next);
        }
        return next;
      });
    },
    [currentUser],
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
      backendAvailable,
      enterLocalMode,
      localMode,
      learningPrefs,
      updateLearningPrefs,
      refreshServerAi,
      setOffsetDays,
      setActiveDocId,
      createDoc,
      renameDoc,
      deleteDoc,
      addAnnotation,
      removeAnnotation,
      reviewNode,
      updateNodeExplanations,
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
      backendAvailable,
      enterLocalMode,
      localMode,
      learningPrefs,
      updateLearningPrefs,
      refreshServerAi,
      setActiveDocId,
      createDoc,
      renameDoc,
      deleteDoc,
      addAnnotation,
      removeAnnotation,
      reviewNode,
      updateNodeExplanations,
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
