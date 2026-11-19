import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, Eye, ListChecks } from 'lucide-react';
import {
  formatRelativeDue,
  GRADE_LABEL,
  isDue,
  STATUS_LABEL,
  statusOf,
} from '../lib/review';
import { matchReviewNodes } from '../lib/reviewMatch';
import type { KnowledgeNode, ReviewGrade } from '../lib/types';
import { useApp } from '../state/AppStore';

interface CardState {
  revealed: boolean;
  grade: ReviewGrade | null;
}

interface ReviewBatch {
  id: string;
  /** 用户写下的知识点；首组到期卡片为空 */
  query: string;
  note: string;
  nodeIds: string[];
  initial?: boolean;
}

const MAX_CARDS = 6;
const EMPTY_CARD: CardState = { revealed: false, grade: null };

export function ReviewPage() {
  const { activeDoc, now, reviewNode } = useApp();
  const docId = activeDoc?.id ?? null;
  const seqRef = useRef(0);
  const [batches, setBatches] = useState<ReviewBatch[]>([]);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [input, setInput] = useState('');
  const [activeCard, setActiveCard] = useState<string | null>(null);

  const nextKey = (prefix: string) => {
    seqRef.current += 1;
    return `${prefix}-${seqRef.current}`;
  };

  // 进入页面或切换会话时，先把今天到期的节点做成第一组卡片
  useEffect(() => {
    setBatches([]);
    setCards({});
    setInput('');
    setActiveCard(null);
    if (!activeDoc) {
      return;
    }
    const due = activeDoc.nodes
      .filter((node) => isDue(node.nextReviewAt, now))
      .slice(0, MAX_CARDS);
    if (due.length === 0) {
      return;
    }
    const batchId = nextKey('batch');
    setBatches([
      {
        id: batchId,
        query: '',
        note: `今天有 ${due.length} 个知识点到期，先做这一组。也可以继续写下想复习的内容。`,
        nodeIds: due.map((node) => node.id),
        initial: true,
      },
    ]);
    setCards(
      Object.fromEntries(
        due.map((node) => [`${batchId}:${node.id}`, { ...EMPTY_CARD }]),
      ),
    );
  }, [docId]);

  const nodeById = useMemo(
    () =>
      new Map<string, KnowledgeNode>(
        (activeDoc?.nodes ?? []).map(
          (node): [string, KnowledgeNode] => [node.id, node],
        ),
      ),
    [activeDoc],
  );

  const navCards = useMemo(() => {
    const list: Array<{ key: string; node: KnowledgeNode }> = [];
    for (const batch of batches) {
      for (const nodeId of batch.nodeIds) {
        const node = nodeById.get(nodeId);
        if (node) {
          list.push({ key: `${batch.id}:${nodeId}`, node });
        }
      }
    }
    return list;
  }, [batches, nodeById]);

  const navIndex = useMemo(
    () =>
      new Map<string, number>(
        navCards.map((card, index): [string, number] => [card.key, index + 1]),
      ),
    [navCards],
  );

  const gradedCount = navCards.filter((card) => cards[card.key]?.grade != null).length;

  // 生成新卡片后滚动到第一张，方便直接开始
  useEffect(() => {
    if (!activeCard) {
      return;
    }
    document
      .getElementById(`review-card-${activeCard}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeCard, batches]);

  const updateCard = (key: string, patch: Partial<CardState>) => {
    setCards((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? EMPTY_CARD), ...patch },
    }));
  };

  const scrollToCard = (key: string) => {
    setActiveCard(key);
    document
      .getElementById(`review-card-${key}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const send = (raw: string) => {
    const query = raw.trim();
    if (!query || !activeDoc) {
      return;
    }
    const matched = matchReviewNodes(activeDoc, query, MAX_CARDS);
    const fallback =
      matched.length === 0
        ? activeDoc.nodes
            .filter((node) => isDue(node.nextReviewAt, now))
            .slice(0, MAX_CARDS)
        : [];
    const nodes = matched.length > 0 ? matched : fallback;
    const batchId = nextKey('batch');
    const note =
      nodes.length === 0
        ? `没有在「${activeDoc.title}」里找到与「${query}」相关的知识点，换个说法再试试。`
        : matched.length > 0
          ? `找到 ${nodes.length} 个相关知识点，已生成卡片。先自己回答，再对照原文。`
          : `没有直接匹配的知识点，先用今天到期的 ${nodes.length} 个节点开始。`;

    setBatches((prev) => [
      ...prev,
      { id: batchId, query, note, nodeIds: nodes.map((node) => node.id) },
    ]);
    if (nodes.length > 0) {
      setCards((prev) => {
        const next = { ...prev };
        for (const node of nodes) {
          next[`${batchId}:${node.id}`] = { ...EMPTY_CARD };
        }
        return next;
      });
      setActiveCard(`${batchId}:${nodes[0].id}`);
    }
    setInput('');
  };

  const renderCard = (batchId: string, node: KnowledgeNode) => {
    const key = `${batchId}:${node.id}`;
    const state = cards[key] ?? EMPTY_CARD;
    const status = statusOf(node, now);
    return (
      <article
        key={key}
        id={`review-card-${key}`}
        className={`review-qcard ${state.grade != null ? 'is-done' : ''}`.trim()}
      >
        <header className="review-qcard__head">
          <span className="review-qcard__label">
            问题 {String(navIndex.get(key) ?? 1).padStart(2, '0')} · {node.title}
          </span>
          <span className="review-qcard__status">
            <i className="status-dot" data-status={status} aria-hidden="true" />
            {STATUS_LABEL[status]}
          </span>
        </header>

        <p className="review-qcard__question">
          {node.question || `请复述「${node.title}」的要点。`}
        </p>

        {state.revealed ? (
          <>
            <div className="quiz-answer review-qcard__answer">
              <p className="quiz-label" style={{ marginBottom: 0 }}>
                原文答案
              </p>
              {node.quoteStart >= 0 ? (
                <p className="quiz-answer__quote">「{node.quote}」</p>
              ) : (
                <p className="quiz-answer__quote" style={{ color: 'var(--text-faint)' }}>
                  这个节点没有可逐字匹配的原句，无法展示可验证的答案。
                </p>
              )}
              <div className="quiz-answer__text">
                <span className="source-text" style={{ fontSize: 11.5 }}>
                  {node.quoteStart >= 0 ? (
                    <>
                      {(activeDoc?.text ?? '').slice(0, node.quoteStart)}
                      <mark className="source-mark">
                        {(activeDoc?.text ?? '').slice(node.quoteStart, node.quoteEnd)}
                      </mark>
                      {(activeDoc?.text ?? '').slice(node.quoteEnd)}
                    </>
                  ) : (
                    activeDoc?.text ?? ''
                  )}
                </span>
              </div>
            </div>

            {state.grade == null ? (
              <div className="quiz-grades">
                {([0, 1, 2] as ReviewGrade[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="grade-button"
                    data-grade={value}
                    onClick={() => {
                      if (!activeDoc) {
                        return;
                      }
                      reviewNode(activeDoc.id, node.id, value);
                      updateCard(key, { grade: value, revealed: true });
                    }}
                  >
                    <span className="grade-button__dot" aria-hidden="true" />
                    {GRADE_LABEL[value]}
                  </button>
                ))}
              </div>
            ) : (
              <p className="review-qcard__graded">
                <Check size={13} />
                已记录「{GRADE_LABEL[state.grade]}」· 下次复习{' '}
                {formatRelativeDue(node.nextReviewAt, now)}
              </p>
            )}
          </>
        ) : (
          <div className="review-qcard__actions">
            <button
              type="button"
              className="glass-button"
              onClick={() => updateCard(key, { revealed: true })}
            >
              <Eye size={15} />
              查看原文答案
            </button>
          </div>
        )}
      </article>
    );
  };

  return (
    <section
      className="assistant-chat assistant-chat--page glass-panel review-page"
      aria-label="今日复习"
    >
      <header className="assistant-chat__head">
        <div className="assistant-chat__title">
          <strong>AI 复习助手</strong>
        </div>
        <span className="review-page__meta">
          {activeDoc
            ? navCards.length > 0
              ? `${gradedCount}/${navCards.length} 已完成`
              : '等待生成卡片'
            : '暂无材料'}
        </span>
      </header>

      <nav className="review-nav" aria-label="问题卡片导航">
        <span className="review-nav__label">
          <ListChecks size={13} />
          卡片
        </span>
        <div className="review-nav__track">
          {navCards.map(({ key, node }, index) => {
            const done = cards[key]?.grade != null;
            return (
              <button
                key={key}
                type="button"
                className={`review-nav__item ${
                  activeCard === key ? 'is-active' : ''
                } ${done ? 'is-done' : ''}`.trim()}
                onClick={() => scrollToCard(key)}
                title={node.title}
              >
                <span className="review-nav__index">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="review-nav__text">{node.title}</span>
                {done ? (
                  <Check size={11} />
                ) : (
                  <i className="status-dot" data-status={statusOf(node, now)} />
                )}
              </button>
            );
          })}
          {navCards.length === 0 && (
            <span className="review-nav__empty">写下知识点后，生成的卡片会出现在这里</span>
          )}
        </div>
      </nav>

      <div className="assistant-chat__list">
        {batches.length === 0 && (
          <div className="assistant-chat__empty">
            <p>
              {activeDoc
                ? `写下你想复习的知识点，我会在「${activeDoc.title}」里找到对应节点，生成可以自测的卡片。`
                : '还没有可复习的材料，先新建一段材料吧。'}
            </p>
            <div className="assistant-chat__hints">
              {(activeDoc?.nodes ?? []).slice(0, 3).map((node) => (
                <button key={node.id} type="button" onClick={() => send(node.title)}>
                  {node.title}
                </button>
              ))}
            </div>
          </div>
        )}

        {batches.map((batch) => (
          <div key={batch.id} className="review-turn">
            {!batch.initial && (
              <div className="assistant-chat__bubble assistant-chat__bubble--user">
                <span className="assistant-chat__bubble-text">{batch.query}</span>
              </div>
            )}
            <div className="assistant-chat__bubble assistant-chat__bubble--assistant">
              <span className="assistant-chat__bubble-text">{batch.note}</span>
            </div>
            {batch.nodeIds.map((nodeId) => {
              const node = nodeById.get(nodeId);
              return node ? renderCard(batch.id, node) : null;
            })}
          </div>
        ))}
      </div>

      <form
        className="assistant-chat__composer"
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
        }}
      >
        <span className="assistant-chat__composer-halo" aria-hidden="true">
          <span className="assistant-chat__composer-halo-ring" />
        </span>
        <textarea
          value={input}
          rows={1}
          placeholder="写下想复习的知识点，例如：牛顿第二定律…"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send(input);
            }
          }}
        />
        <button
          type="submit"
          className="assistant-chat__send"
          disabled={!activeDoc || !input.trim()}
          aria-label="生成题目卡片"
        >
          <ArrowUp size={15} />
        </button>
      </form>
    </section>
  );
}
