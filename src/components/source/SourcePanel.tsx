import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, MessageSquarePlus, SearchCheck, Trash2, X } from 'lucide-react';
import { formatRelativeDue, STATUS_LABEL, statusOf } from '../../lib/review';
import {
  buildSourceSegments,
  normalizeAnnotationRange,
  overlapsAnnotation,
} from '../../lib/annotations';
import type { KnowledgeDoc, KnowledgeNode, SourceAnnotation } from '../../lib/types';
import { useApp } from '../../state/AppStore';
import { usePrefersReducedMotion } from '../../lib/useMediaQuery';

/** 把 **重点** 渲染成加粗 */
function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

interface SourcePanelProps {
  doc: KnowledgeDoc;
  node: KnowledgeNode;
  onClose: () => void;
  onQuiz: () => void;
}

/** 划选后的浮动批注入口 / 输入框 */
interface SelectionDraft {
  start: number;
  end: number;
  quote: string;
  left: number;
  top: number;
}

/** 悬停在某条批注上时显示的独立卡片 */
interface AnnotationCardState {
  id: string;
  note: string;
  left: number;
  top: number;
  above: boolean;
}

const TRIGGER_WIDTH = 96;
const EDITOR_WIDTH = 300;
const EDITOR_HEIGHT = 208;
const CARD_WIDTH = 260;
const MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), Math.max(min, max));
}

export function SourcePanel({ doc, node, onClose, onQuiz }: SourcePanelProps) {
  const { now, addAnnotation, removeAnnotation } = useApp();
  const reducedMotion = usePrefersReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [editor, setEditor] = useState<SelectionDraft | null>(null);
  const [note, setNote] = useState('');
  const [annotationCard, setAnnotationCard] = useState<AnnotationCardState | null>(null);
  const hideCardTimer = useRef<number | null>(null);

  const status = statusOf(node, now);
  const matched = node.quoteStart >= 0 && node.quoteEnd > node.quoteStart;

  const segments = useMemo(
    () =>
      buildSourceSegments(
        doc.text,
        matched ? { start: node.quoteStart, end: node.quoteEnd } : null,
        doc.annotations ?? [],
      ),
    [doc.text, doc.annotations, matched, node.quoteStart, node.quoteEnd],
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const mark = markRef.current;
      if (!mark) {
        container.scrollTo({ top: 0, behavior: 'auto' });
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const markRect = mark.getBoundingClientRect();
      const delta = markRect.top - containerRect.top;
      container.scrollTo({
        top: container.scrollTop + delta - container.clientHeight / 2 + markRect.height / 2,
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [node.id, reducedMotion]);

  // 切换节点时收起批注入口与批注卡片，避免浮层停留在旧位置
  useEffect(() => {
    setSelectionDraft(null);
    setEditor(null);
    setNote('');
    setAnnotationCard(null);
  }, [node.id]);

  useEffect(() => {
    return () => {
      if (hideCardTimer.current !== null) {
        window.clearTimeout(hideCardTimer.current);
      }
    };
  }, []);

  // 批注被删除后，悬停卡片也不能继续显示
  useEffect(() => {
    if (!annotationCard) {
      return;
    }
    const exists = (doc.annotations ?? []).some((item) => item.id === annotationCard.id);
    if (!exists) {
      setAnnotationCard(null);
    }
  }, [annotationCard, doc.annotations]);

  // 滚动 / 改变窗口大小时，固定定位的卡片会错位，直接收起
  useEffect(() => {
    if (!annotationCard) {
      return;
    }
    const close = () => setAnnotationCard(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [annotationCard]);

  useEffect(() => {
    if (!selectionDraft && !editor) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || editorRef.current?.contains(target)) {
        return;
      }
      setSelectionDraft(null);
      setEditor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectionDraft(null);
        setEditor(null);
      }
    };
    const dismiss = () => setSelectionDraft(null);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [selectionDraft, editor]);

  const handleMouseUp = () => {
    const container = textRef.current;
    if (!container) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      return;
    }
    // 渲染出来的文本必须与 doc.text 完全一致，否则字符偏移不可信
    if (container.textContent !== doc.text) {
      return;
    }

    const before = range.cloneRange();
    before.selectNodeContents(container);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const end = start + range.toString().length;
    const normalized = normalizeAnnotationRange(doc.text, start, end);
    if (
      !normalized ||
      overlapsAnnotation(doc.annotations ?? [], normalized.start, normalized.end)
    ) {
      setSelectionDraft(null);
      return;
    }

    const rect = range.getBoundingClientRect();
    setSelectionDraft({
      ...normalized,
      left: clamp(rect.left + rect.width / 2 - TRIGGER_WIDTH / 2, MARGIN, window.innerWidth - TRIGGER_WIDTH - MARGIN),
      top: clamp(rect.bottom + 8, MARGIN, window.innerHeight - 44),
    });
  };

  const cancelHideCard = () => {
    if (hideCardTimer.current !== null) {
      window.clearTimeout(hideCardTimer.current);
      hideCardTimer.current = null;
    }
  };

  const scheduleHideCard = () => {
    cancelHideCard();
    hideCardTimer.current = window.setTimeout(() => {
      hideCardTimer.current = null;
      setAnnotationCard(null);
    }, 140);
  };

  const showAnnotationCard = (element: HTMLElement, annotation: SourceAnnotation) => {
    cancelHideCard();
    const rect = element.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceBelow < 160;
    setAnnotationCard({
      id: annotation.id,
      note: annotation.note,
      left: clamp(
        rect.left + rect.width / 2 - CARD_WIDTH / 2,
        MARGIN,
        window.innerWidth - CARD_WIDTH - MARGIN,
      ),
      top: above ? rect.top - 8 : rect.bottom + 8,
      above,
    });
  };

  const openEditor = () => {
    if (!selectionDraft) {
      return;
    }
    setEditor({
      ...selectionDraft,
      left: clamp(selectionDraft.left - 40, MARGIN, window.innerWidth - EDITOR_WIDTH - MARGIN),
      top: clamp(selectionDraft.top, MARGIN, window.innerHeight - EDITOR_HEIGHT - MARGIN),
    });
    setSelectionDraft(null);
    setNote('');
  };

  const closeEditor = () => {
    setEditor(null);
    setNote('');
    window.getSelection()?.removeAllRanges();
  };

  const saveAnnotation = () => {
    if (!editor) {
      return;
    }
    const value = note.trim();
    if (!value) {
      return;
    }
    addAnnotation(doc.id, { start: editor.start, end: editor.end, note: value });
    closeEditor();
  };

  return (
    <aside className="source-panel glass-panel" aria-label="原文溯源面板">
      <header className="source-panel__head">
        <div>
          <p className="source-panel__eyebrow">原文溯源</p>
          <h3 className="source-panel__title">{node.title}</h3>
          <div className="source-panel__meta">
            <span className="chip" data-status={status}>
              {STATUS_LABEL[status]}
            </span>
            <span className="chip">下次复习 · {formatRelativeDue(node.nextReviewAt, now)}</span>
            <span className="chip">{matched ? '可溯源' : '无出处'}</span>
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭原文面板">
          <X size={17} />
        </button>
      </header>

      <div className="source-panel__body" ref={scrollRef}>
        {node.explanation && (
          <>
            <p className="source-panel__block-label">AI 讲解</p>
            <div className="source-explanation">{renderInline(node.explanation)}</div>
          </>
        )}

        <p className="source-panel__block-label">原文引用</p>
        {matched ? (
          <blockquote className="source-quote">{node.quote}</blockquote>
        ) : (
          <div className="source-no-origin">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              无出处 · 模型没有给出可逐字匹配的原句。回源不会伪造引用，因此这个节点不高亮，并默认置灰。
            </span>
          </div>
        )}

        <p className="source-panel__block-label">
          完整材料
          <span className="source-panel__hint">选中文字即可添加批注</span>
        </p>
        <div className="source-text" ref={textRef} onMouseUp={handleMouseUp}>
          {segments.map((segment) => {
            const content = segment.highlighted ? (
              <mark
                className="source-mark"
                ref={segment.start === node.quoteStart ? markRef : undefined}
              >
                {segment.text}
              </mark>
            ) : (
              segment.text
            );
            const key = `${segment.start}-${segment.end}`;
            if (!segment.annotation) {
              return <Fragment key={key}>{content}</Fragment>;
            }
            const annotation = segment.annotation;
            return (
              <span
                key={key}
                className="source-annotation"
                data-annotation-id={annotation.id}
                tabIndex={0}
                aria-label={`批注：${annotation.note}`}
                onMouseEnter={(event) => showAnnotationCard(event.currentTarget, annotation)}
                onMouseLeave={scheduleHideCard}
                onFocus={(event) => showAnnotationCard(event.currentTarget, annotation)}
                onBlur={(event) => {
                  // 焦点移到卡片里的删除按钮时不要收起
                  if (event.relatedTarget instanceof Node && cardRef.current?.contains(event.relatedTarget)) {
                    return;
                  }
                  scheduleHideCard();
                }}
              >
                {content}
              </span>
            );
          })}
        </div>
      </div>

      <div className="source-panel__actions">
        <button type="button" className="glass-button" onClick={onQuiz}>
          <SearchCheck size={15} />
          开始自测
        </button>
      </div>

      {annotationCard &&
        createPortal(
          <div
            ref={cardRef}
            className="annotation-card"
            style={{
              left: annotationCard.left,
              top: annotationCard.top,
              transform: annotationCard.above ? 'translateY(-100%)' : undefined,
            }}
            role="group"
            aria-label="批注内容"
            onMouseEnter={cancelHideCard}
            onMouseLeave={scheduleHideCard}
          >
            <div className="annotation-card__head">
              <span className="annotation-card__label">批注</span>
              <button
                type="button"
                className="annotation-card__delete"
                aria-label="删除批注"
                title="删除批注"
                onClick={() => {
                  removeAnnotation(doc.id, annotationCard.id);
                  setAnnotationCard(null);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
            <p className="annotation-card__note">{annotationCard.note}</p>
          </div>,
          document.body,
        )}

      {selectionDraft &&
        createPortal(
          <button
            ref={triggerRef}
            type="button"
            className="annotation-trigger"
            style={{ left: selectionDraft.left, top: selectionDraft.top }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openEditor}
          >
            <MessageSquarePlus size={14} />
            批注
          </button>,
          document.body,
        )}

      {editor &&
        createPortal(
          <div
            ref={editorRef}
            className="annotation-editor"
            style={{ left: editor.left, top: editor.top }}
            role="dialog"
            aria-label="添加批注"
          >
            <p className="annotation-editor__quote">「{editor.quote}」</p>
            <textarea
              autoFocus
              rows={3}
              maxLength={2000}
              value={note}
              placeholder="写下你的批注…（⌘/Ctrl + Enter 保存）"
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  saveAnnotation();
                }
              }}
            />
            <div className="annotation-editor__actions">
              <button type="button" className="annotation-editor__cancel" onClick={closeEditor}>
                取消
              </button>
              <button
                type="button"
                className="annotation-editor__save"
                onClick={saveAnnotation}
                disabled={!note.trim()}
              >
                保存
              </button>
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
