import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ArrowUp, FileText, Image as ImageIcon, Menu, Plus, X } from 'lucide-react';
import type { KnowledgeDoc } from '../../lib/types';
import { validateApiConfig } from '../../lib/llm';
import { STATIC_DEPLOY } from '../../lib/auth';
import { detectFileKind, extractFileText, FILE_ACCEPT } from '../../lib/fileText';
import { useApp } from '../../state/AppStore';
import {
  buildAutoStudyBrief,
  buildKnowledgeContext,
  buildLocalAssistantReply,
  requestAssistantReplyStream,
  type ChatContentPart,
  type OutgoingChatMessage,
} from '../../lib/assistant';

/** 行内 Markdown：加粗、斜体、行内代码、http(s) 链接 */
function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) {
      nodes.push(text.slice(last, index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key++} className="assistant-md__code-inline">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\((.+)\)$/);
      nodes.push(
        <a
          key={key++}
          href={link?.[2] ?? '#'}
          target="_blank"
          rel="noreferrer noopener"
        >
          {link?.[1] ?? token}
        </a>,
      );
    }
    last = index + token.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

/** 轻量 Markdown 渲染：标题、列表、代码块、引用、分隔线和行内样式 */
function MarkdownMessage({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  let key = 0;

  const flushList = () => {
    if (!list) {
      return;
    }
    const current = list;
    const Tag = current.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag
        key={`list-${key++}`}
        className={`assistant-md__list ${current.ordered ? 'is-ordered' : ''}`.trim()}
      >
        {current.items.map((item, index) => (
          <li key={index}>{renderInlineMarkdown(item)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };

  const flushCode = () => {
    if (!code) {
      return;
    }
    blocks.push(
      <pre key={`code-${key++}`} className="assistant-md__pre">
        <code>{code.join('\n')}</code>
      </pre>,
    );
    code = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (code) {
      if (/^\s*```/.test(line)) {
        flushCode();
      } else {
        code.push(raw);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushList();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushList();
      blocks.push(<span key={`gap-${key++}`} className="assistant-md__gap" />);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2]);
      if (level === 1) {
        blocks.push(
          <p key={`h-${key++}`} className="assistant-md__h1">
            {content}
          </p>,
        );
      } else if (level === 2) {
        blocks.push(
          <p key={`h-${key++}`} className="assistant-md__h2">
            {content}
          </p>,
        );
      } else {
        blocks.push(
          <p key={`h-${key++}`} className="assistant-md__h3">
            {content}
          </p>,
        );
      }
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushList();
      blocks.push(<hr key={`hr-${key++}`} className="assistant-md__hr" />);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushList();
      blocks.push(
        <blockquote key={`quote-${key++}`} className="assistant-md__quote">
          {renderInlineMarkdown(line.replace(/^>\s?/, ''))}
        </blockquote>,
      );
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ordered || bullet) {
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push((ordered?.[1] ?? bullet?.[1] ?? '').trim());
      continue;
    }
    flushList();
    blocks.push(
      <p key={`p-${key++}`} className="assistant-md__p">
        {renderInlineMarkdown(line.trim())}
      </p>,
    );
  }
  flushCode();
  flushList();

  return <div className="assistant-md">{blocks}</div>;
}

interface AssistantChatProps {
  open: boolean;
  doc: KnowledgeDoc | null;
  /** 全部会话：助手作为神经中枢，可以跨会话回答 */
  docs?: KnowledgeDoc[];
  onClose: () => void;
  /** 打开题库自测（个性化学习入口） */
  onStartQuiz?: () => void;
  /** 每次从侧栏进入助手都换一个值，用来开启新的助手会话 */
  sessionToken?: number;
  /**
   * hub：侧栏入口，接入全部会话、无快捷标签；
   * doc：图谱页入口，只针对当前材料，自动总结 + 出题。
   */
  mode?: 'hub' | 'doc';
  /** popover：右下角浮动窗；page：铺在主内容区 */
  variant?: 'popover' | 'page';
}

interface Position {
  left: number;
  top: number;
}

interface Attachment {
  id: string;
  name: string;
  kind: 'text' | 'image';
  text?: string;
  image?: string;
}

interface AttachmentMeta {
  name: string;
  kind: 'text' | 'image';
  preview?: string;
}

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  files?: AttachmentMeta[];
}

const PANEL_MARGIN = 10;
const MAX_FILES = 3;
const MAX_TEXT_CHARS = 10000;
const MAX_TEXT_SIZE = 2 * 1024 * 1024;
const MAX_DOC_SIZE = 20 * 1024 * 1024;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
/** 记住最近 15 条会话（用户 + 助手），下次打开继续接着聊 */
const MEMORY_LIMIT = 15;
const MEMORY_PREFIX = 'ks.assistant.memory.v1';

function memoryKey(userId: string): string {
  return `${MEMORY_PREFIX}:${userId}`;
}

/** 清洗历史消息：只保留角色、文本和附件元信息，最多保留最近 15 条 */
function sanitizeEntries(value: unknown): ChatEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: ChatEntry[] = [];
  for (const item of value) {
    const role = (item as ChatEntry | undefined)?.role;
    const content = (item as ChatEntry | undefined)?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      continue;
    }
    const rawFiles = (item as ChatEntry | undefined)?.files;
    const files: AttachmentMeta[] = [];
    if (Array.isArray(rawFiles)) {
      for (const file of rawFiles) {
        if (file && typeof file.name === 'string' && (file.kind === 'text' || file.kind === 'image')) {
          files.push({ name: file.name, kind: file.kind });
        }
      }
    }
    entries.push({ role, content, ...(files.length > 0 ? { files } : {}) });
  }
  return entries.slice(-MEMORY_LIMIT);
}

function readMemory(key: string | null): ChatEntry[] {
  if (!key) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? sanitizeEntries(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

interface AssistantThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatEntry[];
}

const THREADS_PREFIX = 'ks.assistant.threads.v1';
const ACTIVE_THREAD_PREFIX = 'ks.assistant.active.v1';
const THREAD_LIMIT = 30;

function threadsKeyOf(userId?: string): string | null {
  return userId ? `${THREADS_PREFIX}:${userId}` : null;
}

function activeThreadKeyOf(userId?: string): string | null {
  return userId ? `${ACTIVE_THREAD_PREFIX}:${userId}` : null;
}

function createThreadId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function titleFromMessages(messages: ChatEntry[]): string {
  const first = messages.find((entry) => entry.role === 'user' && entry.content.trim());
  if (!first) {
    return '新会话';
  }
  const clean = first.content.replace(/\s+/g, ' ').trim();
  return clean.length > 22 ? `${clean.slice(0, 22)}…` : clean;
}

function makeThread(messages: ChatEntry[] = []): AssistantThread {
  const now = Date.now();
  return {
    id: createThreadId(),
    title: titleFromMessages(messages),
    createdAt: now,
    updatedAt: now,
    messages,
  };
}

function sanitizeThreads(value: unknown): AssistantThread[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const threads: AssistantThread[] = [];
  for (const item of value) {
    const entry = item as Partial<AssistantThread> | null;
    if (!entry || typeof entry.id !== 'string') {
      continue;
    }
    threads.push({
      id: entry.id,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : '新会话',
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
      messages: sanitizeEntries(entry.messages),
    });
  }
  return threads
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, THREAD_LIMIT);
}

function readThreads(key: string | null): AssistantThread[] {
  if (!key) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? sanitizeThreads(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeThreads(key: string | null, threads: AssistantThread[]): void {
  if (!key) {
    return;
  }
  try {
    // 图片预览等大字段不落盘，只存附件名称和类型，避免撑爆本地存储
    const safe = threads.slice(0, THREAD_LIMIT).map((thread) => ({
      ...thread,
      messages: thread.messages.map((entry) => ({
        role: entry.role,
        content: entry.content,
        ...(entry.files && entry.files.length > 0
          ? { files: entry.files.map((file) => ({ name: file.name, kind: file.kind })) }
          : {}),
      })),
    }));
    window.localStorage.setItem(key, JSON.stringify(safe));
  } catch {
    // 存储已满时放弃历史记录，不影响当前会话
  }
}

function readActiveThread(key: string | null): string | null {
  if (!key) {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeActiveThread(key: string | null, id: string): void {
  if (!key) {
    return;
  }
  try {
    window.localStorage.setItem(key, id);
  } catch {
    // 忽略存储失败
  }
}

function formatThreadTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.max(1, Math.floor(diff / 3_600_000))} 小时前`;
  }
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

async function compressImage(file: File): Promise<string> {
  const dataUrl = await readAsDataUrl(file);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`解析图片 ${file.name} 失败`));
    image.src = dataUrl;
  });
  const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    return dataUrl;
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function toAttachment(file: File): Promise<Attachment> {
  const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (file.type.startsWith('image/')) {
    if (file.size > MAX_IMAGE_SIZE) {
      throw new Error(`${file.name} 超过 5MB`);
    }
    return { id, name: file.name, kind: 'image', image: await compressImage(file) };
  }
  const kind = detectFileKind(file);
  const limit = kind === 'text' ? MAX_TEXT_SIZE : MAX_DOC_SIZE;
  if (file.size > limit) {
    throw new Error(`${file.name} 超过 ${Math.round(limit / 1024 / 1024)}MB`);
  }
  try {
    const { text, truncated } = await extractFileText(file, MAX_TEXT_CHARS);
    if (!text.trim()) {
      throw new Error('没有读到文字，可能是扫描版 PDF，请改用图片上传');
    }
    return {
      id,
      name: file.name,
      kind: 'text',
      text: truncated ? `${text}\n\n[内容较长，已截断]` : text,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${file.name}：${message}`);
  }
}

export function AssistantChat({
  open,
  doc,
  docs = [],
  onClose,
  onStartQuiz,
  sessionToken,
  mode = 'hub',
  variant = 'popover',
}: AssistantChatProps) {
  const { apiConfig, currentUser, aiReady } = useApp();
  const memoryStorageKey = currentUser ? memoryKey(currentUser.id) : null;
  const threadsStorageKey = currentUser ? threadsKeyOf(currentUser.id) : null;
  const activeStorageKey = currentUser ? activeThreadKeyOf(currentUser.id) : null;
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const attachRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [threads, setThreads] = useState<AssistantThread[]>(() => readThreads(threadsStorageKey));
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() =>
    readActiveThread(activeStorageKey),
  );
  // 整页形态默认展开会话栏；窄屏默认收起成侧边窄条
  const [historyOpen, setHistoryOpen] = useState(
    () => variant === 'page' && !window.matchMedia('(max-width: 760px)').matches,
  );
  const [messages, setMessages] = useState<ChatEntry[]>(() => {
    const list = readThreads(threadsStorageKey);
    const active =
      list.find((thread) => thread.id === readActiveThread(activeStorageKey)) ?? list[0];
    return active ? active.messages : readMemory(memoryStorageKey);
  });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  // 历史面板按最近更新排序
  const sortedThreads = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);

  // 用户切换 / 首次进入：读取历史会话；旧版单会话记忆自动迁移成第一条记录
  useEffect(() => {
    if (!threadsStorageKey) {
      setThreads([]);
      setActiveThreadId(null);
      setMessages([]);
      return;
    }
    let list = readThreads(threadsStorageKey);
    if (list.length === 0) {
      const legacy = readMemory(memoryStorageKey);
      const thread = makeThread(legacy);
      list = [thread];
      writeThreads(threadsStorageKey, list);
      writeActiveThread(activeStorageKey, thread.id);
    }
    const active =
      list.find((thread) => thread.id === readActiveThread(activeStorageKey)) ?? list[0];
    setThreads(list);
    setActiveThreadId(active?.id ?? null);
    setMessages(active?.messages ?? []);
    if (active) {
      writeActiveThread(activeStorageKey, active.id);
    }
  }, [threadsStorageKey, activeStorageKey, memoryStorageKey]);

  // 侧栏 / 图谱入口每次进入都开一条新会话；doc 入口保留材料开场
  const seededSession = useRef<number | null>(null);
  useEffect(() => {
    if (variant !== 'page' || !open || sessionToken === undefined) {
      return;
    }
    if (seededSession.current === sessionToken) {
      return;
    }
    if (mode === 'doc' && !doc) {
      return;
    }
    seededSession.current = sessionToken;
    const brief = mode === 'doc' ? buildAutoStudyBrief(doc) : null;
    const stored = readThreads(threadsStorageKey);
    // 当前会话还是空的就复用它，避免反复点入口堆出多条空会话
    const current =
      stored.find((thread) => thread.id === readActiveThread(activeStorageKey)) ?? stored[0];
    const reusable = !brief && current && current.messages.length === 0 ? current : null;
    const thread = reusable ?? makeThread(brief ? [{ role: 'assistant', content: brief }] : []);
    const next = reusable ? stored : [thread, ...stored].slice(0, THREAD_LIMIT);
    writeThreads(threadsStorageKey, next);
    setThreads(next);
    setActiveThreadId(thread.id);
    writeActiveThread(activeStorageKey, thread.id);
    setMessages(thread.messages);
    setError(null);
    if (variant !== 'page') {
      setHistoryOpen(false);
    }
  }, [
    sessionToken,
    open,
    variant,
    mode,
    doc,
    docs,
    threadsStorageKey,
    activeStorageKey,
  ]);

  // 对话结束后把消息写回当前会话；流式期间不反复写盘
  useEffect(() => {
    if (loading || !threadsStorageKey || !activeThreadId) {
      return;
    }
    setThreads((prev) => {
      const target = prev.find((thread) => thread.id === activeThreadId);
      if (!target || target.messages === messages) {
        return prev;
      }
      const next = prev.map((thread) =>
        thread.id === activeThreadId
          ? {
              ...thread,
              messages,
              title: titleFromMessages(messages),
              updatedAt: Date.now(),
            }
          : thread,
      );
      writeThreads(threadsStorageKey, next);
      return next;
    });
  }, [messages, loading, activeThreadId, threadsStorageKey]);

  // 浮窗打开时重新读取最新会话，和整页助手共享历史
  useEffect(() => {
    if (variant !== 'popover' || !open || !threadsStorageKey) {
      return;
    }
    const list = readThreads(threadsStorageKey);
    const active =
      list.find((thread) => thread.id === readActiveThread(activeStorageKey)) ?? list[0];
    setThreads(list);
    if (active) {
      setActiveThreadId(active.id);
      setMessages(active.messages);
    }
  }, [open, variant, threadsStorageKey, activeStorageKey]);

  const selectThread = (id: string) => {
    const thread = threads.find((item) => item.id === id);
    if (!thread) {
      return;
    }
    setActiveThreadId(id);
    writeActiveThread(activeStorageKey, id);
    setMessages(thread.messages);
    setAttachments([]);
    setInput('');
    setError(null);
    if (variant !== 'page') {
      setHistoryOpen(false);
    }
  };

  const startNewThread = () => {
    const thread = makeThread();
    setThreads((prev) => {
      const next = [thread, ...prev].slice(0, THREAD_LIMIT);
      writeThreads(threadsStorageKey, next);
      return next;
    });
    setActiveThreadId(thread.id);
    writeActiveThread(activeStorageKey, thread.id);
    setMessages([]);
    setAttachments([]);
    setInput('');
    setError(null);
    if (variant !== 'page') {
      setHistoryOpen(false);
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages, loading, open]);

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!attachRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // 浮窗的历史面板：点击面板外或按 Esc 收起；整页形态的会话栏常驻，不自动收起
  useEffect(() => {
    if (!historyOpen || variant !== 'popover') {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        setHistoryOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [historyOpen, variant]);

  const clampPosition = (left: number, top: number): Position => {
    const panel = panelRef.current;
    const width = panel?.offsetWidth ?? 340;
    const height = panel?.offsetHeight ?? 420;
    return {
      left: Math.min(Math.max(PANEL_MARGIN, left), window.innerWidth - width - PANEL_MARGIN),
      top: Math.min(Math.max(PANEL_MARGIN, top), window.innerHeight - height - PANEL_MARGIN),
    };
  };

  const onDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) {
      return;
    }
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    setPosition(
      clampPosition(
        drag.originX + event.clientX - drag.startX,
        drag.originY + event.clientY - drag.startY,
      ),
    );
  };

  const onDragEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const addFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) {
      return;
    }
    const room = MAX_FILES - attachments.length;
    if (room <= 0) {
      setError(`最多上传 ${MAX_FILES} 个附件`);
      return;
    }
    const picked = Array.from(fileList).slice(0, room);
    setError(null);
    const next: Attachment[] = [];
    for (const file of picked) {
      try {
        next.push(await toAttachment(file));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    if (next.length > 0) {
      setAttachments((current) => [...current, ...next]);
    }
  };

  const send = async (text: string) => {
    const content = text.trim();
    if ((!content && attachments.length === 0) || loading) {
      return;
    }
    const files = attachments;
    const next: ChatEntry[] = [
      ...messages,
      {
        role: 'user',
        content,
        files: files.map((file) => ({
          name: file.name,
          kind: file.kind,
          preview: file.kind === 'image' ? file.image : undefined,
        })),
      },
    ];
    const textFiles = files.filter((file) => file.kind === 'text');
    const images = files.filter((file) => file.kind === 'image');
    const combined = [
      content,
      ...textFiles.map((file) => `[附件：${file.name}]\n${file.text ?? ''}`),
    ]
      .filter(Boolean)
      .join('\n\n');

    let outgoing: string | ChatContentPart[] = combined;
    if (images.length > 0) {
      const parts: ChatContentPart[] = [
        { type: 'text', text: combined || '请查看上传的图片。' },
      ];
      for (const file of images) {
        if (file.image) {
          parts.push({ type: 'image_url', image_url: { url: file.image } });
        }
      }
      outgoing = parts;
    }

    const history: OutgoingChatMessage[] = [
      ...messages.slice(-(MEMORY_LIMIT - 1)).map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: 'user', content: outgoing },
    ];

    const userConfig = apiConfig && validateApiConfig(apiConfig).ok ? apiConfig : null;
    const scopedDocs = mode === 'doc' ? (doc ? [doc] : []) : docs;

    // 没有可用模型时，用本地已整理好的要点直接回答总结 / 出题 / 复习安排
    if (!userConfig && !aiReady) {
      const localReply = buildLocalAssistantReply(doc, content, scopedDocs);
      if (localReply) {
        setMessages([...next, { role: 'assistant', content: localReply }]);
        setInput('');
        setAttachments([]);
        setError(null);
        return;
      }
    }

    setMessages([...next, { role: 'assistant', content: '' }]);
    setInput('');
    setAttachments([]);
    setError(null);
    setLoading(true);
    let acc = '';
    try {
      const reply = await requestAssistantReplyStream(
        history,
        buildKnowledgeContext(scopedDocs, doc),
        userConfig,
        (delta) => {
          acc += delta;
          setMessages([...next, { role: 'assistant', content: acc }]);
        },
      );
      setMessages([...next, { role: 'assistant', content: reply }]);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        if (!acc) {
          setMessages(next);
        }
        setError(
          STATIC_DEPLOY && !acc
            ? '静态体验版没有连接模型服务。可以在本地运行后端并配置 API Key，或者直接让我做总结、出题、安排复习。'
            : cause instanceof Error
              ? cause.message
              : String(cause),
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const lastMessage = messages[messages.length - 1];
  const streamingIdle =
    loading && (!lastMessage || lastMessage.role !== 'assistant' || !lastMessage.content);

  return (
    <section
      ref={panelRef}
      className={`assistant-chat glass-panel ${
        variant === 'page' ? 'assistant-chat--page' : open ? 'is-open' : 'is-hidden'
      }`.trim()}
      style={
        variant === 'popover' && position
          ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto' }
          : undefined
      }
      role={variant === 'page' ? 'region' : 'dialog'}
      aria-label="AI 助手对话"
      aria-hidden={variant === 'page' ? undefined : !open}
    >
      {variant === 'page' && (
        <aside
          className={`assistant-chat__threads ${historyOpen ? 'is-open' : ''}`.trim()}
          aria-label="会话记录"
        >
          <div className="assistant-chat__threads-inner">
            <div className="assistant-chat__threads-head">
              <button
                type="button"
                className={`assistant-chat__history-toggle ${historyOpen ? 'is-open' : ''}`.trim()}
                onClick={() => setHistoryOpen((value) => !value)}
                aria-label={historyOpen ? '收起会话记录' : '展开会话记录'}
                aria-expanded={historyOpen}
                title={historyOpen ? '收起会话记录' : '展开会话记录'}
              >
                <Menu size={15} />
              </button>
              <span className="assistant-chat__threads-label">会话记录</span>
              <button
                type="button"
                className="assistant-chat__history-new"
                onClick={startNewThread}
                title="新建会话"
              >
                <Plus size={12} />
                新建会话
              </button>
            </div>
            <div className="assistant-chat__history-list">
              {sortedThreads.length === 0 && (
                <p className="assistant-chat__history-empty">还没有会话记录。</p>
              )}
              {sortedThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={`assistant-chat__history-item ${
                    thread.id === activeThreadId ? 'is-active' : ''
                  }`.trim()}
                  onClick={() => selectThread(thread.id)}
                >
                  <span className="assistant-chat__history-title">{thread.title}</span>
                  <span className="assistant-chat__history-meta">
                    {formatThreadTime(thread.updatedAt)} · {thread.messages.length} 条消息
                  </span>
                </button>
              ))}
            </div>
          </div>
        </aside>
      )}

      <div className="assistant-chat__pane">
        <header
          className={`assistant-chat__head ${variant === 'page' ? 'is-static' : ''}`.trim()}
          onPointerDown={variant === 'page' ? undefined : onDragStart}
          onPointerMove={variant === 'page' ? undefined : onDragMove}
          onPointerUp={variant === 'page' ? undefined : onDragEnd}
          onPointerCancel={variant === 'page' ? undefined : onDragEnd}
        >
          <div className="assistant-chat__title">
            <strong>AI 助手</strong>
            <span className="assistant-chat__doc">
              {activeThread && activeThread.messages.length > 0
                ? activeThread.title
                : doc
                  ? mode === 'doc'
                    ? `当前知识库 · ${doc.title}`
                    : docs.length > 0
                      ? `${docs.length} 个会话 · ${doc.title}`
                      : doc.title
                  : '新会话'}
            </span>
          </div>
          {variant === 'popover' && (
            <div className="assistant-chat__actions">
              <button
                type="button"
                className={`assistant-chat__history-toggle ${historyOpen ? 'is-open' : ''}`.trim()}
                onClick={() => setHistoryOpen((value) => !value)}
                aria-label="历史会话"
                aria-haspopup="dialog"
                aria-expanded={historyOpen}
                title="历史会话"
              >
                <Menu size={14} />
              </button>
              <button
                type="button"
                className="assistant-chat__close"
                onClick={onClose}
                aria-label="关闭 AI 助手"
              >
                <X size={12} />
              </button>
            </div>
          )}
        </header>

      {historyOpen && variant === 'popover' && (
        <div className="assistant-chat__history" role="dialog" aria-label="历史会话">
          <div className="assistant-chat__history-head">
            <span>历史会话</span>
            <button
              type="button"
              className="assistant-chat__history-new"
              onClick={startNewThread}
            >
              <Plus size={12} />
              新建会话
            </button>
          </div>
          <div className="assistant-chat__history-list">
            {threads.length === 0 && (
              <p className="assistant-chat__history-empty">还没有会话记录。</p>
            )}
            {sortedThreads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className={`assistant-chat__history-item ${
                  thread.id === activeThreadId ? 'is-active' : ''
                }`.trim()}
                onClick={() => selectThread(thread.id)}
              >
                <span className="assistant-chat__history-title">{thread.title}</span>
                <span className="assistant-chat__history-meta">
                  {formatThreadTime(thread.updatedAt)} · {thread.messages.length} 条消息
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="assistant-chat__list" ref={listRef}>
        {messages.length === 0 && variant !== 'page' && (
          <div className="assistant-chat__empty">
            <p>基于全部会话提问，材料里没有的内容会直接说明。</p>
            <div className="assistant-chat__hints">
              {['总结这次会话', '解释一个概念', '生成复习问题'].map((hint) => (
                <button key={hint} type="button" onClick={() => void send(hint)}>
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) => {
          const visible =
            Boolean(message.content) || Boolean(message.files && message.files.length > 0);
          if (!visible) {
            return null;
          }
          return (
            <div
              key={`${message.role}-${index}`}
              className={`assistant-chat__bubble assistant-chat__bubble--${message.role}`}
            >
              {message.content &&
                (message.role === 'assistant' ? (
                  <div className="assistant-chat__bubble-text is-rich">
                    <MarkdownMessage text={message.content} />
                    {loading && index === messages.length - 1 && (
                      <span className="assistant-chat__caret" aria-hidden="true" />
                    )}
                  </div>
                ) : (
                  <span className="assistant-chat__bubble-text">
                    {message.content}
                    {loading && index === messages.length - 1 && (
                      <span className="assistant-chat__caret" aria-hidden="true" />
                    )}
                  </span>
                ))}
              {message.files && message.files.length > 0 && (
                <div className="assistant-chat__bubble-files">
                  {message.files.map((file) => (
                    <span key={file.name} className="assistant-chat__bubble-file">
                      {file.preview ? (
                        <img src={file.preview} alt={file.name} />
                      ) : (
                        <FileText size={13} />
                      )}
                      <span>{file.name}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {loading && streamingIdle && (
          <div className="assistant-chat__bubble assistant-chat__bubble--assistant assistant-chat__typing">
            <span />
            <span />
            <span />
          </div>
        )}

        {error && (
          <div className="assistant-chat__error" role="alert">
            {error}
          </div>
        )}
      </div>

      {attachments.length > 0 && (
        <div className="assistant-chat__attachments">
          {attachments.map((file) => (
            <span key={file.id} className="assistant-chat__attachment">
              {file.kind === 'image' && file.image ? (
                <img src={file.image} alt={file.name} />
              ) : (
                <FileText size={13} />
              )}
              <span>{file.name}</span>
              <button
                type="button"
                onClick={() =>
                  setAttachments((current) => current.filter((item) => item.id !== file.id))
                }
                aria-label={`移除 ${file.name}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {variant === 'page' && mode === 'doc' && doc && (
        <div className="assistant-chat__quickbar">
          {[
            { label: '总结要点', prompt: '总结这份材料，列出最重要的 5 个要点' },
            { label: '逐个讲解', prompt: '请逐个讲解这份材料里的所有知识点，每个知识点先给一句话总结，再把原文引用里的重点词展开解释' },
            { label: '个性化复习', prompt: '根据我现在的掌握情况，帮我安排今天的复习顺序' },
            { label: '出 5 道题', prompt: '基于这份材料出 5 道自测题，先给题目再给答案' },
            { label: '诊断薄弱', prompt: '帮我诊断这份材料的薄弱点，优先补缺' },
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={loading}
              onClick={() => void send(action.prompt)}
            >
              {action.label}
            </button>
          ))}
          {onStartQuiz && (
            <button type="button" className="is-accent" onClick={onStartQuiz}>
              开始自测
            </button>
          )}
        </div>
      )}

      {variant === 'page' && mode === 'hub' && docs.length > 0 && (
        <div className="assistant-chat__quickbar">
          {[
            { label: '总结全部会话', prompt: '帮我总结全部会话，列出每个会话最核心的 2-3 个要点' },
            { label: '逐个讲解', prompt: '从所有会话里挑出最关键的 8 个知识点，逐个详细讲解' },
            { label: '全局薄弱诊断', prompt: '诊断我所有会话的薄弱点，优先补缺' },
            { label: '安排今日复习', prompt: '根据我全部会话的到期和掌握情况，安排今天的复习顺序' },
            { label: '跨会话出题', prompt: '从不同会话各挑一题，出 5 道跨会话自测题' },
            { label: '考前突击', prompt: '我要考前突击，给我 30 分钟跨会话冲刺计划' },
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={loading}
              onClick={() => void send(action.prompt)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      <form
        className="assistant-chat__composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <span className="assistant-chat__composer-halo" aria-hidden="true">
          <span className="assistant-chat__composer-halo-ring" />
        </span>
        <div className="assistant-chat__attach-wrap" ref={attachRef}>
          <button
            type="button"
            className="assistant-chat__attach"
            onClick={() => setPickerOpen((open) => !open)}
            aria-label="上传图片或文件"
            aria-haspopup="menu"
            aria-expanded={pickerOpen}
            title="上传图片或文件"
          >
            <Plus size={16} />
          </button>
          {pickerOpen && (
            <div className="assistant-chat__attach-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setPickerOpen(false);
                  imageRef.current?.click();
                }}
              >
                <ImageIcon size={13} />
                上传图片
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setPickerOpen(false);
                  fileRef.current?.click();
                }}
              >
                <FileText size={13} />
                <span className="assistant-chat__attach-label">
                  上传文件
                  <small>PDF / Word / PPT / 文本</small>
                </span>
              </button>
            </div>
          )}
          <input
            ref={imageRef}
            type="file"
            multiple
            accept="image/*"
            className="assistant-chat__file-input"
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            className="assistant-chat__file-input"
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
        <textarea
          value={input}
          rows={1}
          placeholder="问点什么…"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send(input);
            }
          }}
        />
        <button
          type="submit"
          className="assistant-chat__send"
          disabled={loading || (!input.trim() && attachments.length === 0)}
          aria-label="发送"
        >
          <ArrowUp size={15} />
        </button>
      </form>
      </div>
    </section>
  );
}
