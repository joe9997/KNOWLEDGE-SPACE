import { useEffect, useRef } from 'react';
import { AlertTriangle, SearchCheck, X } from 'lucide-react';
import { formatRelativeDue, STATUS_LABEL, statusOf } from '../../lib/review';
import type { KnowledgeDoc, KnowledgeNode } from '../../lib/types';
import { useApp } from '../../state/AppStore';
import { usePrefersReducedMotion } from '../../lib/useMediaQuery';

interface SourcePanelProps {
  doc: KnowledgeDoc;
  node: KnowledgeNode;
  onClose: () => void;
  onQuiz: () => void;
}

export function SourcePanel({ doc, node, onClose, onQuiz }: SourcePanelProps) {
  const { now } = useApp();
  const reducedMotion = usePrefersReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);
  const status = statusOf(node, now);
  const matched = node.quoteStart >= 0 && node.quoteEnd > node.quoteStart;

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

  const before = matched ? doc.text.slice(0, node.quoteStart) : doc.text;
  const highlighted = matched ? doc.text.slice(node.quoteStart, node.quoteEnd) : '';
  const after = matched ? doc.text.slice(node.quoteEnd) : '';

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

        <p className="source-panel__block-label">完整材料</p>
        <div className="source-text">
          {before}
          {matched && (
            <mark className="source-mark" ref={markRef}>
              {highlighted}
            </mark>
          )}
          {after}
        </div>
      </div>

      <div className="source-panel__actions">
        <button type="button" className="glass-button" onClick={onQuiz}>
          <SearchCheck size={15} />
          开始自测
        </button>
      </div>
    </aside>
  );
}
