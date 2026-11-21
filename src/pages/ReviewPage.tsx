import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, Eye, ListChecks } from 'lucide-react';
import {
  collectDueNodesFromDocs,
  formatRelativeDue,
  GRADE_LABEL,
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
  const { docs, activeDoc, now, reviewNode } = useApp();
  const seqRef = useRef(0);
  const [batches, setBatches] = useState<ReviewBatch[]>([]);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [input, setInput] = useState('');
  const [activeCard, setActiveCard] = useState<string | null>(null);

  const nextKey = (prefix: string) => {
    seqRef.current += 1;
    return `${prefix}-${seqRef.current}`;
  };

  // 全局 nodeId → { docId, node }，跨所有 docs 建，方便跨会话复习
  const nodeMap = useMemo(() => {
    const map = new Map<string, { docId: string; docTitle: string; node: KnowledgeNode; text: string }>();
    for (const doc of docs) {
      for (const node of doc.nodes) {
        map.set(node.id, { docId: doc.id, docTitle: doc.title, node, text: doc.text });
      }
    }
    return map;
  }, [docs]);

  // 进入页面时自动把所有 docs 今天到期/临近的节点做成第一组卡片
  useEffect(() => {
    setBatches([]);
    setCards({});
    setInput('');
    setActiveCard(null);
    const due = collectDueNodesFromDocs(docs, now).slice(0, MAX_CARDS);
    if (due.length === 0) {
      return;
    }
    const batchId = nextKey('batch');
    setBatches([
      {
        id: batchId,
        query: '',
        note: `今天有 ${due.length} 个知识点到期或临近，先做这一组。也可以继续写下想复习的内容。`,
        nodeIds: due.map((item) => item.node.id),
        initial: true,
      },
    ]);
    setCards(
      Object.fromEntries(
        due.map((item) => [`${batchId}:${item.node.id}`, { ...EMPTY_CARD }]),
      ),
    );
  }, [docs, now]);

  const navCards = useMemo(() => {
    const list: Array<{ key: string; node: KnowledgeNode; docId: string; docTitle: string }> = [];
    for (const batch of batches) {
      for (const nodeId of batch.nodeIds) {
        const item = nodeMap.get(nodeId);
        if (item) {
          list.push({
            key: `${batch.id}:${nodeId}`,
            node: item.node,
            docId: item.docId,
            docTitle: item.docTitle,
          });
        }
      }
    }
    return list;
  }, [batches, nodeMap]);

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
    if (!query) {
      return;
    }
    // 优先在 activeDoc 里匹配；没匹配到就退回到全 docs 的到期/临近节点
    const matched = activeDoc ? matchReviewNodes(activeDoc, query, MAX_CARDS) : [];
    const fallbackNodes = collectDueNodesFromDocs(docs, now).slice(0, MAX_CARDS).map((i) => i.node);
    const nodes = matched.length > 0 ? matched : fallbackNodes;
    const batchId = nextKey('batch');
    const note =
      nodes.length === 0
        ? '没有找到相关的知识点。'
        : matched.length > 0
          ? `在「${activeDoc?.title}」找到 ${nodes.length} 个相关知识点，已生成卡片。先自己回答，再对照原文。`
          : `没有直接匹配的，先给你今天到期/临近的 ${nodes.length} 个节点。`;

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
    const item = nodeMap.get(node.id);
    const sourceText = item?.text ?? '';
    const docTitle = item?.docTitle ?? '';
    return (
      <article
        key={key}
        id={`review-card-${key}`}
        className={`review-qcard ${state.grade != null ? 'is-done' : ''}`.trim()}
      >
        <header className="review-qcard__head">
          <span className="review-qcard__label">
            问题 {String(navIndex.get(key) ?? 1).padStart(2, '0')} · {node.title}
            {docTitle && <em className="review-qcard__doc">来自《{docTitle}》</em>}
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
                      {sourceText.slice(0, node.quoteStart)}
                      <mark className="source-mark">
                        {sourceText.slice(node.quoteStart, node.quoteEnd)}
                      </mark>
                      {sourceText.slice(node.quoteEnd)}
                    </>
                  ) : (
                    sourceText
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
                      const owner = nodeMap.get(node.id);
                      if (!owner) return;
                      reviewNode(owner.docId, node.id, value);
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
          {navCards.length > 0
            ? `${gradedCount}/${navCards.length} 已完成`
            : '等待生成卡片'}
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
            <span className="review-nav__empty">暂无到期或临近的节点。继续探索材料吧。</span>
          )}
        </div>
      </nav>

      <div className="assistant-chat__list">
        {batches.length === 0 && (
          <div className="assistant-chat__empty">
            <p>
              暂时没有到期或临近复习的节点。你可以继续探索材料，或把时间拨到三天后看看。
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
              const item = nodeMap.get(nodeId);
              return item ? renderCard(batch.id, item.node) : null;
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
          disabled={!input.trim()}
          aria-label="生成题目卡片"
        >
          <ArrowUp size={15} />
        </button>
      </form>
    </section>
  );
}
