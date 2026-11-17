import { useEffect, useMemo, useState } from 'react';
import { Check, Eye } from 'lucide-react';
import { GRADE_LABEL, statusOf } from '../../lib/review';
import type { KnowledgeDoc, ReviewGrade } from '../../lib/types';
import { useApp } from '../../state/AppStore';
import { Modal } from '../ui/Modal';

interface QuizModalProps {
  open: boolean;
  doc: KnowledgeDoc | null;
  queue: string[];
  onClose: () => void;
}

const EMPTY_RESULTS: Record<ReviewGrade, number> = { 0: 0, 1: 0, 2: 0 };

export function QuizModal({ open, doc, queue, onClose }: QuizModalProps) {
  const { reviewNode, now } = useApp();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [results, setResults] = useState<Record<ReviewGrade, number>>(EMPTY_RESULTS);
  const queueKey = queue.join('|');

  useEffect(() => {
    if (!open) {
      return;
    }
    setIndex(0);
    setRevealed(false);
    setResults(EMPTY_RESULTS);
  }, [open, queueKey]);

  const nodes = useMemo(() => {
    if (!doc) {
      return [];
    }
    return queue
      .map((id) => doc.nodes.find((node) => node.id === id))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
  }, [doc, queue]);

  const current = nodes[index];
  const finished = nodes.length > 0 && index >= nodes.length;

  const grade = (value: ReviewGrade) => {
    if (!doc || !current) {
      return;
    }
    reviewNode(doc.id, current.id, value);
    setResults((prev) => ({ ...prev, [value]: prev[value] + 1 }));
    setRevealed(false);
    setIndex((prev) => prev + 1);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={finished ? '本轮复习完成' : '回到原句 · 自测'}
      eyebrow="SELF CHECK"
      size="md"
    >
      {!doc || nodes.length === 0 ? (
        <div>
          <p className="quiz-question" style={{ fontSize: 20 }}>
            今天没有到期的节点。
          </p>
          <p className="quiz-hint" style={{ color: 'var(--text-faint)', fontSize: 12 }}>
            可以回到知识网络继续探索，或切换演示时间查看三天后、七天后的复习安排。
          </p>
          <div className="quiz-actions" style={{ marginTop: 22 }}>
            <button type="button" className="glass-button" onClick={onClose}>
              回到知识网络
            </button>
          </div>
        </div>
      ) : finished ? (
        <div className="quiz-result">
          <div className="quiz-result__mark">
            <Check size={24} />
          </div>
          <h3>这一轮走完了</h3>
          <p>自评已同步到节点颜色、待复习数量与下一次复习时间。</p>
          <div className="quiz-result__stats">
            <div>
              <strong>{results[2]}</strong>
              <span>已经掌握</span>
            </div>
            <div>
              <strong>{results[1]}</strong>
              <span>有点模糊</span>
            </div>
            <div>
              <strong>{results[0]}</strong>
              <span>还没记住</span>
            </div>
          </div>
          <button type="button" className="glass-button" onClick={onClose}>
            完成
          </button>
        </div>
      ) : (
        <div>
          <div className="quiz-progress">
            <span>
              {index + 1} / {nodes.length}
            </span>
            <span className="quiz-progress__bar">
              <span style={{ width: `${(index / nodes.length) * 100}%` }} />
            </span>
            <span>{statusOf(current, now) === 'due' ? '到期' : '复习中'}</span>
          </div>

          <p className="quiz-label">回忆</p>
          <p className="quiz-question">{current.question || `请复述「${current.title}」的要点。`}</p>

          {revealed ? (
            <>
              <div className="quiz-answer">
                <p className="quiz-label" style={{ marginBottom: 0 }}>
                  原文答案
                </p>
                {current.quoteStart >= 0 ? (
                  <p className="quiz-answer__quote">「{current.quote}」</p>
                ) : (
                  <p className="quiz-answer__quote" style={{ color: 'var(--text-faint)' }}>
                    这个节点没有可逐字匹配的原句，无法展示可验证的答案。
                  </p>
                )}
                <div className="quiz-answer__text">
                  <span
                    className="source-text"
                    style={{ fontSize: 11.5 }}
                  >
                    {current.quoteStart >= 0 ? (
                      <>
                        {doc.text.slice(0, current.quoteStart)}
                        <mark className="source-mark">
                          {doc.text.slice(current.quoteStart, current.quoteEnd)}
                        </mark>
                        {doc.text.slice(current.quoteEnd)}
                      </>
                    ) : (
                      doc.text
                    )}
                  </span>
                </div>
              </div>
              <p className="quiz-label">自评</p>
              <div className="quiz-grades">
                {([0, 1, 2] as ReviewGrade[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="grade-button"
                    data-grade={value}
                    onClick={() => grade(value)}
                  >
                    <span className="grade-button__dot" aria-hidden="true" />
                    {GRADE_LABEL[value]}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <p
                className="quiz-hint"
                style={{
                  fontSize: 11.5,
                  color: 'var(--text-faint)',
                  marginBottom: 18,
                  lineHeight: 1.9,
                }}
              >
                先在心里回答，再对照原文那一句。不要急着看答案。
              </p>
              <div className="quiz-actions">
                <button
                  type="button"
                  className="glass-button"
                  onClick={() => setRevealed(true)}
                >
                  <Eye size={15} />
                  查看原文答案
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
