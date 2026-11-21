import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Brain, Check, Eye, ListChecks, Trash2 } from 'lucide-react';
import {
  collectDueNodesFromDocs,
  formatRelativeDue,
  GRADE_LABEL,
  STATUS_LABEL,
  statusOf,
} from '../lib/review';
import { matchReviewNodes } from '../lib/reviewMatch';
import {
  buildAnswerAnalysis,
  buildKnowledgeContext,
  buildLocalAssistantReply,
  buildNodeExplanation,
  requestAssistantReplyStream,
} from '../lib/assistant';
import type { OutgoingChatMessage } from '../lib/assistant';
import { downloadPdf } from '../lib/exportMarkdown';
import { validateApiConfig } from '../lib/llm';
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
  /** true 表示这是纯问答（AI 神经中枢），不渲染复习卡片 */
  isChat?: boolean;
  /** true 表示该条 note 仍在流式生成中 */
  streaming?: boolean;
}

const MAX_CARDS = 6;
const EMPTY_CARD: CardState = { revealed: false, grade: null };
/** 今日复习的问答历史：只存聊天轮次，最多保留 40 轮 */
const HISTORY_LIMIT = 40;
const HISTORY_PREFIX = 'ks.review.hub.v1';

/** 神经中枢快捷入口：默认不预置任何消息，只保留这些按钮 */
const HUB_HINTS = [
  { label: '总结全部会话', prompt: '帮我总结全部会话，列出每个会话最核心的 2-3 个要点' },
  { label: '逐个讲解', prompt: '从所有会话里挑出最关键的 8 个知识点，逐个详细讲解' },
  { label: '全局薄弱诊断', prompt: '诊断我所有会话的薄弱点，优先补缺' },
  { label: '安排今日复习', prompt: '根据我全部会话的到期和掌握情况，安排今天的复习顺序' },
  { label: '跨会话出题', prompt: '从不同会话各挑一题，出 5 道跨会话自测题' },
  { label: '导出 PDF 笔记', prompt: '导出 PDF 笔记' },
];

function historyKeyOf(userId: string | undefined): string | null {
  return userId ? `${HISTORY_PREFIX}:${userId}` : null;
}

/** 从本地存储恢复聊天记录（只恢复问答，不恢复复习卡片） */
function readHistory(key: string | null): ReviewBatch[] {
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const turns: ReviewBatch[] = [];
    parsed.slice(-HISTORY_LIMIT).forEach((item, index) => {
      const entry = item as { query?: unknown; note?: unknown } | null;
      if (!entry || typeof entry.query !== 'string' || typeof entry.note !== 'string') return;
      if (!entry.note.trim()) return;
      turns.push({
        id: `history-${index}`,
        query: entry.query,
        note: entry.note,
        nodeIds: [],
        isChat: true,
      });
    });
    return turns;
  } catch {
    return [];
  }
}

/** 把问答记录写入本地存储；没有记录时直接清空，避免残留旧内容 */
function writeHistory(key: string | null, batches: ReviewBatch[]): void {
  if (!key) return;
  const turns = batches
    .filter((batch) => batch.isChat && batch.query.trim() && batch.note.trim())
    .slice(-HISTORY_LIMIT)
    .map(({ query, note }) => ({ query, note }));
  try {
    if (turns.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(turns));
  } catch {
    // 本地存储不可用或已满时放弃持久化，不影响当前对话
  }
}

/** 神经中枢意图识别：把用户输入路由到复习 / 总结 / 出题 / 导出 / 自由问答 */
function detectIntent(text: string): 'review' | 'summary' | 'quiz' | 'export-pdf' | 'chat' {
  const t = text.trim();
  if (/导出|下载|保存.*笔记/.test(t)) return 'export-pdf';
  if (/出题|测验|考[我试]|测一测|quiz|questions?/i.test(t) && !/^(什么|为什么|怎么|如何|解释)/.test(t)) return 'quiz';
  if (/总结|摘要|概括|梳理|归纳|summary/i.test(t) && !/^(什么|为什么)/.test(t)) return 'summary';
  // 「安排 / 顺序 / 计划」是让中枢给方案，不要生成复习卡片
  if (/计划|安排|顺序|怎么复习|如何复习/.test(t)) return 'chat';
  // 疑问句一律走问答；带「复习 / 卡片」等动作词的走复习卡片
  const isQuestion = /[?？]$/.test(t) || /^(什么|为什么|怎么|如何|解释|介绍|告诉我|说说|讲讲|帮我理解|谁|哪)/.test(t);
  if (!isQuestion && /复习|回顾|卡片|自测|抽背|背一背/.test(t)) return 'review';
  return 'chat';
}

export function ReviewPage() {
  const { docs, activeDoc, now, reviewNode, apiConfig, aiReady, currentUser } = useApp();
  const historyKey = historyKeyOf(currentUser?.id);
  const seqRef = useRef(0);
  const loadedKeyRef = useRef<string | null | undefined>(undefined);
  const skipSaveRef = useRef(false);
  const [batches, setBatches] = useState<ReviewBatch[]>([]);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [input, setInput] = useState('');
  const [activeCard, setActiveCard] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  // 登录用户确定后恢复该用户的问答记录；默认保持空白，只显示快捷按钮
  useEffect(() => {
    if (loadedKeyRef.current === historyKey) {
      return;
    }
    loadedKeyRef.current = historyKey;
    skipSaveRef.current = true;
    setBatches(readHistory(historyKey));
    setCards({});
    setActiveCard(null);
  }, [historyKey]);

  // 流式生成期间不落盘，等这一轮结束再写入
  useEffect(() => {
    if (loadedKeyRef.current !== historyKey) {
      return;
    }
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    if (batches.some((batch) => batch.streaming)) {
      return;
    }
    writeHistory(historyKey, batches);
  }, [batches, historyKey]);

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

  /** 生成复习卡片（原 send 逻辑） */
  const spawnReviewCards = (query: string) => {
    const matched = activeDoc ? matchReviewNodes(activeDoc, query, MAX_CARDS) : [];
    const fallbackNodes = collectDueNodesFromDocs(docs, now).slice(0, MAX_CARDS).map((i) => i.node);
    const nodes = matched.length > 0 ? matched : fallbackNodes;
    const batchId = nextKey('batch');
    const note =
      nodes.length === 0
        ? '没有找到相关的知识点。可以换个问法，或直接问我任何问题。'
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
  };

  /** 神经中枢问答：带上历史对话，流式调用 AI；无可用模型时退回本地检索 */
  const askNeuralHub = async (query: string) => {
    const batchId = nextKey('chat');
    // 收集此前的问答，形成多轮上下文（最多 10 条，避免上下文过长）
    const history: OutgoingChatMessage[] = [];
    for (const batch of batches) {
      if (!batch.isChat || !batch.query.trim() || !batch.note.trim()) continue;
      history.push({ role: 'user', content: batch.query });
      history.push({ role: 'assistant', content: batch.note });
    }
    const messages: OutgoingChatMessage[] = [
      ...history.slice(-10),
      { role: 'user', content: query },
    ];
    // 先插入用户问题 + 一个空回答占位
    setBatches((prev) => [
      ...prev,
      { id: batchId, query, note: '', nodeIds: [], isChat: true, streaming: true },
    ]);

    const userConfig = apiConfig && validateApiConfig(apiConfig).ok ? apiConfig : null;
    const scopedDocs = docs.length > 0 ? docs : activeDoc ? [activeDoc] : [];

    // 无可用模型：直接用本地检索 / 总结兜底
    if (!userConfig && !aiReady) {
      const localReply =
        buildLocalAssistantReply(activeDoc, query, scopedDocs) ??
        '我是这个知识库的神经中枢，可以回答跨会话的问题、生成复习卡片、导出笔记或出题。\n\n试着问我：「总结一下今天的内容」「帮我复习牛顿定律」「导出 PDF 笔记」「出 5 道题考考我」。';
      setBatches((prev) =>
        prev.map((b) => (b.id === batchId ? { ...b, note: localReply, streaming: false } : b)),
      );
      return;
    }

    // 有模型：走流式，并带上历史对话，支持连续追问
    let acc = '';
    try {
      await requestAssistantReplyStream(
        messages,
        buildKnowledgeContext(scopedDocs, activeDoc),
        userConfig,
        (delta) => {
          acc += delta;
          setBatches((prev) =>
            prev.map((b) => (b.id === batchId ? { ...b, note: acc } : b)),
          );
        },
      );
      setBatches((prev) =>
        prev.map((b) => (b.id === batchId ? { ...b, streaming: false } : b)),
      );
    } catch (cause) {
      const fallback =
        buildLocalAssistantReply(activeDoc, query, scopedDocs) ??
        `调用模型失败：${cause instanceof Error ? cause.message : String(cause)}`;
      setBatches((prev) =>
        prev.map((b) => (b.id === batchId ? { ...b, note: fallback, streaming: false } : b)),
      );
    }
  };

  const send = async (raw: string) => {
    const query = raw.trim();
    if (!query || loading) return;
    setInput('');

    const intent = detectIntent(query);

    // 导出：直接触发下载，不进对话流
    if (intent === 'export-pdf') {
      if (!activeDoc) {
        setBatches((prev) => [
          ...prev,
          {
            id: nextKey('chat'),
            query,
            note: '当前没有打开的会话，先去图谱页打开一份材料再导出。',
            nodeIds: [],
            isChat: true,
          },
        ]);
        return;
      }
      downloadPdf(activeDoc, now);
      setBatches((prev) => [
        ...prev,
        {
          id: nextKey('chat'),
          query,
          note: `已为你导出《${activeDoc.title}》的 PDF 笔记。`,
          nodeIds: [],
          isChat: true,
        },
      ]);
      return;
    }

    // 复习卡片：走原有逻辑
    if (intent === 'review') {
      spawnReviewCards(query);
      return;
    }

    // 总结 / 出题 / 自由问答：都走神经中枢
    setLoading(true);
    try {
      await askNeuralHub(query);
    } finally {
      setLoading(false);
    }
  };

  const clearHistory = () => {
    if (batches.length === 0) return;
    if (!window.confirm('确定清空今日复习的聊天记录吗？清空后无法恢复。')) return;
    setBatches([]);
    setCards({});
    setActiveCard(null);
    writeHistory(historyKey, []);
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
                AI 讲解
              </p>
              <p className="quiz-answer__quote">{buildNodeExplanation(node)}</p>
              <p className="review-qcard__analysis">🔍 {buildAnswerAnalysis(node)}</p>
              <details className="review-qcard__source">
                <summary>查看原文出处</summary>
                {node.quoteStart >= 0 ? (
                  <>
                    <p className="quiz-answer__quote">「{node.quote}」</p>
                    <div className="quiz-answer__text">
                      <span className="source-text" style={{ fontSize: 11.5 }}>
                        {sourceText.slice(0, node.quoteStart)}
                        <mark className="source-mark">
                          {sourceText.slice(node.quoteStart, node.quoteEnd)}
                        </mark>
                        {sourceText.slice(node.quoteEnd)}
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="quiz-answer__quote" style={{ color: 'var(--text-faint)' }}>
                    这个节点没有可逐字匹配的原句，无法展示原文出处。
                  </p>
                )}
              </details>
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
              查看答案与解析
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
          <strong>
            <Brain size={15} style={{ marginRight: 6, verticalAlign: -2 }} />
            AI 神经中枢 · 今日复习
          </strong>
        </div>
        <div className="review-page__head-right">
          <span className="review-page__meta">
            {navCards.length > 0
              ? `${gradedCount}/${navCards.length} 已完成`
              : `已连接 ${docs.length} 个会话`}
          </span>
          <button
            type="button"
            className="review-page__clear"
            onClick={clearHistory}
            disabled={batches.length === 0}
            title="清空聊天记录"
          >
            <Trash2 size={12} />
            清空记录
          </button>
        </div>
      </header>

      {navCards.length > 0 && (
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
          </div>
        </nav>
      )}

      <div className="assistant-chat__list">
        {batches.length === 0 && (
          <div className="assistant-chat__empty assistant-chat__empty--hub">
            <div className="assistant-chat__hints">
              {HUB_HINTS.map((hint) => (
                <button
                  key={hint.label}
                  type="button"
                  disabled={loading}
                  onClick={() => void send(hint.prompt)}
                >
                  {hint.label}
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
              <span className="assistant-chat__bubble-text">
                {batch.note}
                {batch.streaming && (
                  <span className="assistant-chat__caret" aria-hidden="true" />
                )}
              </span>
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
          void send(input);
        }}
      >
        <span className="assistant-chat__composer-halo" aria-hidden="true">
          <span className="assistant-chat__composer-halo-ring" />
        </span>
        <textarea
          value={input}
          rows={1}
          placeholder="问问题、要总结、出题、复习、导出笔记…"
          disabled={loading}
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
          disabled={!input.trim() || loading}
          aria-label="发送给神经中枢"
        >
          <ArrowUp size={15} />
        </button>
      </form>
    </section>
  );
}
