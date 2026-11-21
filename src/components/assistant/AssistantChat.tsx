import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUp, FileText, Image as ImageIcon, Plus, X } from 'lucide-react';
import type { KnowledgeDoc } from '../../lib/types';
import { validateApiConfig } from '../../lib/llm';
import { STATIC_DEPLOY } from '../../lib/auth';
import { detectFileKind, extractFileText, FILE_ACCEPT } from '../../lib/fileText';
import { useApp } from '../../state/AppStore';
import {
  buildAutoStudyBrief,
  buildHubStudyBrief,
  buildKnowledgeContext,
  buildLocalAssistantReply,
  requestAssistantReplyStream,
  type ChatContentPart,
  type OutgoingChatMessage,
} from '../../lib/assistant';
type RichLineKind = 'title' | 'meta' | 'section' | 'item' | 'detail' | 'answer' | 'body';

/** 按行判断内容类型，让总结 / 出题这些长文本有字号与字体的层次 */
function classifyLine(line: string, index: number): RichLineKind {
  const text = line.trim();
  if (index === 0) {
    return 'title';
  }
  if (/^(当前知识库|已连接最近会话|本地(总结|总览|检索|出题|学习计划))/.test(text)) {
    return 'title';
  }
  if (/^(主题|摘要|规模|共\s*\d+\s*个要点|命中\s*\d+\s*条|已接入\s*\d+\s*个会话)/.test(text)) {
    return 'meta';
  }
  if (/^(答案|参考答案)\s*[:：]/.test(text)) {
    return 'answer';
  }
  if (/^\s{2,}\S/.test(line)) {
    return 'detail';
  }
  if (/^(讲解|结构|自测|正面|背面|卡片\s*\d+)[：:]/.test(text) || /^卡片\s*\d+$/.test(text)) {
    return 'detail';
  }
  if (/^\d+[.、]\s/.test(text) || /^[-·•]\s/.test(text)) {
    return 'item';
  }
  if (/[:：]$/.test(text) && text.length <= 40) {
    return 'section';
  }
  return 'body';
}

/** 把 **重点** 渲染成加粗，其余保持普通文本 */
function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

function RichMessage({ text }: { text: string }) {
  return (
    <div className="assistant-rich">
      {text.split('\n').map((line, index) => {
        if (!line.trim()) {
          return <span key={index} className="assistant-rich__gap" aria-hidden="true" />;
        }
        const kind = classifyLine(line, index);
        return (
          <span key={index} className={`assistant-rich__${kind}`}>
            {renderInline(line.trim())}
          </span>
        );
      })}
    </div>
  );
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

/** 只保留可安全落盘的结构，图片预览等大字段不写入本地存储 */
function compactEntries(entries: ChatEntry[]): ChatEntry[] {
  return entries.slice(-MEMORY_LIMIT).map((entry) => ({
    role: entry.role,
    content: entry.content,
    ...(entry.files && entry.files.length > 0
      ? {
          files: entry.files.map((file) => ({ name: file.name, kind: file.kind })),
        }
      : {}),
  }));
}

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
    entries.push({ role, content });
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

function writeMemory(key: string | null, entries: ChatEntry[]): void {
  if (!key) {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(compactEntries(entries)));
  } catch {
    // 本地存储不可用或已满时放弃记忆，不影响当前对话
  }
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
  const [messages, setMessages] = useState<ChatEntry[]>(() => readMemory(memoryStorageKey));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 侧栏入口（hub）跨所有 docs 自动总结；图谱页入口（doc）针对当前材料自动总结
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
    const brief = mode === 'doc' ? buildAutoStudyBrief(doc) : buildHubStudyBrief(docs);
    setMessages(brief ? [{ role: 'assistant', content: brief }] : []);
    setError(null);
  }, [sessionToken, open, variant, mode, doc, docs]);

  // 流式输出期间不落盘，等这一轮结束再写入最近 15 条
  useEffect(() => {
    if (loading) {
      return;
    }
    writeMemory(memoryStorageKey, messages);
  }, [messages, loading, memoryStorageKey]);

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
      <header
        className={`assistant-chat__head ${variant === 'page' ? 'is-static' : ''}`.trim()}
        onPointerDown={variant === 'page' ? undefined : onDragStart}
        onPointerMove={variant === 'page' ? undefined : onDragMove}
        onPointerUp={variant === 'page' ? undefined : onDragEnd}
        onPointerCancel={variant === 'page' ? undefined : onDragEnd}
      >
        <div className="assistant-chat__title">
          <strong>AI 助手</strong>
          {doc && (
            <span className="assistant-chat__doc">
              {mode === 'doc'
                ? `当前知识库 · ${doc.title}`
                : docs.length > 0
                  ? `${docs.length} 个会话 · ${doc.title}`
                  : doc.title}
            </span>
          )}
        </div>
        {variant === 'popover' && (
          <button
            type="button"
            className="assistant-chat__close"
            onClick={onClose}
            aria-label="关闭 AI 助手"
          >
            <X size={12} />
          </button>
        )}
      </header>

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
                    <RichMessage text={message.content} />
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
    </section>
  );
}
