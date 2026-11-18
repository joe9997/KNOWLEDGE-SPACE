import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUp, FileText, Image as ImageIcon, Plus, X } from 'lucide-react';
import type { KnowledgeDoc } from '../../lib/types';
import { validateApiConfig } from '../../lib/llm';
import { detectFileKind, extractFileText, FILE_ACCEPT } from '../../lib/fileText';
import { useApp } from '../../state/AppStore';
import {
  buildDocContext,
  requestAssistantReplyStream,
  type ChatContentPart,
  type OutgoingChatMessage,
} from '../../lib/assistant';

interface AssistantChatProps {
  open: boolean;
  doc: KnowledgeDoc | null;
  onClose: () => void;
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
  onClose,
  variant = 'popover',
}: AssistantChatProps) {
  const { apiConfig } = useApp();
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
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      ...messages.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: outgoing },
    ];

    setMessages([...next, { role: 'assistant', content: '' }]);
    setInput('');
    setAttachments([]);
    setError(null);
    setLoading(true);
    let acc = '';
    try {
      const userConfig =
        apiConfig && validateApiConfig(apiConfig).ok ? apiConfig : null;
      const reply = await requestAssistantReplyStream(
        history,
        buildDocContext(doc),
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
        setError(cause instanceof Error ? cause.message : String(cause));
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
        {messages.length === 0 && (
          <div className="assistant-chat__empty">
            <p>
              {variant === 'page'
                ? '可以问任何会话里的概念，也可以上传 PDF、Word、图片或文本让我读。'
                : '基于当前会话提问，材料里没有的内容会直接说明。'}
            </p>
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
              {message.content && (
                <span className="assistant-chat__bubble-text">
                  {message.content}
                  {loading && index === messages.length - 1 && (
                    <span className="assistant-chat__caret" aria-hidden="true" />
                  )}
                </span>
              )}
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
                  <small>PDF / Word / 文本</small>
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
