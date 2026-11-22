import { useMemo, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { buildAnswerAnalysis, buildNodeExplanation } from '../lib/assistant';
import { formatRelativeDue, GRADE_LABEL, isDue, STATUS_LABEL, statusOf } from '../lib/review';
import type { KnowledgeDoc, KnowledgeNode, ReviewGrade } from '../lib/types';
import { useApp } from '../state/AppStore';

type Filter = 'all' | 'due' | 'weak';

interface ReviewGroup {
  doc: KnowledgeDoc;
  items: KnowledgeNode[];
}

export function ReviewPage() {
  const { docs, activeDoc, now, reviewNode } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [graded, setGraded] = useState<Record<string, ReviewGrade>>({});

  const groups = useMemo<ReviewGroup[]>(() => {
    const ordered = activeDoc
      ? [activeDoc, ...docs.filter((doc) => doc.id !== activeDoc.id)]
      : docs;
    return ordered
      .map((doc) => {
        const items = doc.nodes
          .filter((node) => {
            // 多节点材料里，level 0 是章节导航，不作为复习卡片
            if (node.level === 0 && doc.nodes.length > 1) {
              return false;
            }
            if (filter === 'due') {
              return isDue(node.nextReviewAt, now);
            }
            if (filter === 'weak') {
              return node.mastery < 2;
            }
            return true;
          })
          .slice()
          .sort((a, b) => {
            const dueDiff =
              Number(isDue(b.nextReviewAt, now)) - Number(isDue(a.nextReviewAt, now));
            return dueDiff || a.title.localeCompare(b.title, 'zh');
          });
        return { doc, items };
      })
      .filter((group) => group.items.length > 0);
  }, [activeDoc, docs, filter, now]);

  const reviewable = (doc: KnowledgeDoc) =>
    doc.nodes.filter((node) => !(node.level === 0 && doc.nodes.length > 1));

  const total = docs.reduce((sum, doc) => sum + reviewable(doc).length, 0);
  const dueCount = docs.reduce(
    (sum, doc) =>
      sum + reviewable(doc).filter((node) => isDue(node.nextReviewAt, now)).length,
    0,
  );
  const weakCount = docs.reduce(
    (sum, doc) => sum + reviewable(doc).filter((node) => node.mastery < 2).length,
    0,
  );
  const doneCount = Object.keys(graded).length;

  const gradeNode = (doc: KnowledgeDoc, node: KnowledgeNode, value: ReviewGrade) => {
    reviewNode(doc.id, node.id, value);
    setGraded((prev) => ({ ...prev, [`${doc.id}:${node.id}`]: value }));
  };

  return (
    <section className="review-modules glass-panel" aria-label="今日复习">
      <header className="review-modules__head">
        <div>
          <p className="eyebrow">REVIEW</p>
          <h2>今日复习</h2>
          <p className="review-modules__meta">
            共 {total} 个知识点 · 今日到期 {dueCount} 个 · 未掌握 {weakCount} 个
            {doneCount > 0 ? ` · 本轮已完成 ${doneCount} 个` : ''}
          </p>
        </div>
        <div className="review-modules__filters" role="tablist" aria-label="复习范围">
          {(
            [
              ['all', `全部 ${total}`],
              ['due', `今日到期 ${dueCount}`],
              ['weak', `未掌握 ${weakCount}`],
            ] as Array<[Filter, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={filter === value ? 'is-active' : ''}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="review-modules__list">
        {groups.length === 0 && (
          <p className="review-modules__empty">
            {filter === 'due'
              ? '今天没有到期的知识点，可以切到「全部」继续巩固。'
              : '还没有可复习的知识点，先新建一段材料吧。'}
          </p>
        )}

        {groups.map(({ doc, items }) => (
          <section key={doc.id} className="review-module" aria-label={doc.title}>
            <header className="review-module__head">
              <h3>{doc.title}</h3>
              <span>{items.length} 个知识点</span>
            </header>

            <div className="review-module__cards">
              {items.map((node, index) => {
                const key = `${doc.id}:${node.id}`;
                const open = openKey === key;
                const state = graded[key];
                const status = statusOf(node, now);
                return (
                  <article
                    key={key}
                    className={`review-module-card ${state != null ? 'is-done' : ''}`.trim()}
                  >
                    <button
                      type="button"
                      className="review-module-card__head"
                      aria-expanded={open}
                      onClick={() => setOpenKey(open ? null : key)}
                    >
                      <span className="review-module-card__index">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="review-module-card__title">
                        {node.question || `请复述「${node.title}」的要点。`}
                      </span>
                      <span className="review-module-card__status">
                        <i className="status-dot" data-status={status} aria-hidden="true" />
                        {STATUS_LABEL[status]}
                      </span>
                      <ChevronDown
                        size={15}
                        className={`review-module-card__chevron ${open ? 'is-open' : ''}`.trim()}
                      />
                    </button>

                    {open && (
                      <div className="review-module-card__body">
                        <p className="review-module-card__label">参考答案</p>
                        {node.quoteStart >= 0 ? (
                          <p className="quiz-answer__quote">「{node.quote}」</p>
                        ) : (
                          <p className="quiz-answer__quote" style={{ color: 'var(--text-faint)' }}>
                            这个节点没有可逐字匹配的原句，只能参考下方讲解。
                          </p>
                        )}
                        <p className="review-module-card__explain">
                          {buildNodeExplanation(node)}
                        </p>
                        <p className="review-module-card__analysis">
                          🔍 {buildAnswerAnalysis(node)}
                        </p>

                        {state == null ? (
                          <div className="quiz-grades">
                            {([0, 1, 2] as ReviewGrade[]).map((value) => (
                              <button
                                key={value}
                                type="button"
                                className="grade-button"
                                data-grade={value}
                                onClick={() => gradeNode(doc, node, value)}
                              >
                                <span className="grade-button__dot" aria-hidden="true" />
                                {GRADE_LABEL[value]}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="review-qcard__graded">
                            <Check size={13} />
                            已记录「{GRADE_LABEL[state]}」· 下次复习{' '}
                            {formatRelativeDue(node.nextReviewAt, now)}
                          </p>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
