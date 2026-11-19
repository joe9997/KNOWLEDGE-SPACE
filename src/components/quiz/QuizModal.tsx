import { useMemo, useRef, useState, useEffect } from 'react';
import { ArrowRight, Check, Eye, ListChecks, X } from 'lucide-react';
import { buildChoiceQuestions } from '../../lib/quizBank';
import type { ChoiceQuestion, QuizMode } from '../../lib/quizBank';
import { GRADE_LABEL, statusOf } from '../../lib/review';
import type { KnowledgeDoc, ReviewGrade } from '../../lib/types';
import { useApp } from '../../state/AppStore';
import { Modal } from '../ui/Modal';

interface QuizModalProps {
  open: boolean;
  doc: KnowledgeDoc | null;
  queue: string[];
  initialMode: QuizMode | null;
  onClose: () => void;
}

const EMPTY_RESULTS: Record<ReviewGrade, number> = { 0: 0, 1: 0, 2: 0 };

export function QuizModal({ open, doc, queue, initialMode, onClose }: QuizModalProps) {
  const { reviewNode, now } = useApp();
  const [mode, setMode] = useState<QuizMode | null>(initialMode);
  const [questions, setQuestions] = useState<ChoiceQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [results, setResults] = useState<Record<ReviewGrade, number>>(EMPTY_RESULTS);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const answeredRef = useRef(false);
  const queueKey = queue.join('|');

  const startMode = (nextMode: QuizMode | null) => {
    setMode(nextMode);
    setQuestions(nextMode === 'choice' && doc ? buildChoiceQuestions(doc, queue) : []);
    setIndex(0);
    setRevealed(false);
    setResults(EMPTY_RESULTS);
    setSelectedOptionId(null);
    answeredRef.current = false;
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    startMode(initialMode);
    // 只在打开新队列时生成一次题目，答题导致 doc 更新后不能重新洗牌。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, queueKey, initialMode]);

  const nodes = useMemo(() => {
    if (!doc) {
      return [];
    }
    return queue
      .map((id) => doc.nodes.find((node) => node.id === id))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
  }, [doc, queue]);

  const total = mode === 'choice' ? questions.length : nodes.length;
  const finished = mode !== null && total > 0 && index >= total;
  const current = nodes[index];
  const currentQuestion = questions[index];

  const grade = (value: ReviewGrade) => {
    if (!doc || !current) {
      return;
    }
    reviewNode(doc.id, current.id, value);
    setResults((prev) => ({ ...prev, [value]: prev[value] + 1 }));
    setRevealed(false);
    setIndex((prev) => prev + 1);
  };

  const answerChoice = (optionId: string) => {
    if (!doc || !currentQuestion || answeredRef.current) {
      return;
    }
    answeredRef.current = true;
    const value: ReviewGrade = optionId === currentQuestion.correctOptionId ? 2 : 0;
    reviewNode(doc.id, currentQuestion.nodeId, value);
    setResults((prev) => ({ ...prev, [value]: prev[value] + 1 }));
    setSelectedOptionId(optionId);
  };

  const nextChoice = () => {
    answeredRef.current = false;
    setSelectedOptionId(null);
    setIndex((prev) => prev + 1);
  };

  const renderEmpty = () => (
    <div>
      <p className="quiz-question" style={{ fontSize: 20 }}>
        {initialMode === 'self' && queue.length === 0
          ? '今天没有到期的节点。'
          : '当前材料还没有可自测的知识点。'}
      </p>
      <p className="quiz-hint" style={{ color: 'var(--text-faint)', fontSize: 12 }}>
        {initialMode === 'self' && queue.length === 0
          ? '可以回到知识网络继续探索，或从题库复习全部知识点。'
          : '先导入讲义并生成知识网络，再来这里检查掌握情况。'}
      </p>
      <div className="quiz-actions" style={{ marginTop: 22 }}>
        <button type="button" className="glass-button" onClick={onClose}>
          回到知识网络
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={finished ? '本轮答题完成' : mode === 'choice' ? '题库 · 自动选择题' : '回到原句 · 自测'}
      eyebrow="KNOWLEDGE CHECK"
      size="md"
    >
      {!doc ? (
        renderEmpty()
      ) : mode === null ? (
        <div className="quiz-mode-grid">
          <button type="button" className="quiz-mode-card" onClick={() => startMode('choice')}>
            <ListChecks size={23} />
            <strong>自动选择题</strong>
            <span>从当前材料的原文生成选项，即时判分并更新掌握度。</span>
          </button>
          <button type="button" className="quiz-mode-card" onClick={() => startMode('self')}>
            <Eye size={23} />
            <strong>问答自评</strong>
            <span>先回忆再对照原文，连续完成全部知识点。</span>
          </button>
        </div>
      ) : finished ? (
        <div className="quiz-result">
          <div className="quiz-result__mark">
            <Check size={24} />
          </div>
          <h3>这一轮走完了</h3>
          <p>答题结果已同步到节点颜色、待复习数量与下一次复习时间。</p>
          <div className="quiz-result__stats">
            <div>
              <strong>{results[2]}</strong>
              <span>{mode === 'choice' ? '回答正确' : '已经掌握'}</span>
            </div>
            {mode === 'self' && (
              <div>
                <strong>{results[1]}</strong>
                <span>有点模糊</span>
              </div>
            )}
            <div>
              <strong>{results[0]}</strong>
              <span>{mode === 'choice' ? '回答错误' : '还没记住'}</span>
            </div>
          </div>
          <button type="button" className="glass-button" onClick={onClose}>
            完成并查看图谱
          </button>
        </div>
      ) : mode === 'choice' && !currentQuestion ? (
        <div>
          <p className="quiz-question" style={{ fontSize: 20 }}>暂时无法生成选择题</p>
          <p className="quiz-hint" style={{ color: 'var(--text-faint)', lineHeight: 1.9 }}>
            至少需要两条不同的可溯源原文才能生成选项。你仍可以使用问答自评复习当前材料。
          </p>
          <div className="quiz-actions">
            <button type="button" className="glass-button" onClick={() => startMode('self')}>
              改用问答自评
            </button>
            <button type="button" className="text-button" onClick={() => startMode(null)}>
              返回模式选择
            </button>
          </div>
        </div>
      ) : mode === 'self' && !current ? (
        renderEmpty()
      ) : (
        <div>
          <div className="quiz-progress">
            <span>{Math.min(index + 1, total)} / {total}</span>
            <span className="quiz-progress__bar">
              <span style={{ width: `${(index / Math.max(total, 1)) * 100}%` }} />
            </span>
            <span>{mode === 'choice' ? '即时判分' : statusOf(current, now) === 'due' ? '到期' : '复习中'}</span>
          </div>

          {mode === 'choice' && currentQuestion ? (
            <>
              <p className="quiz-label">选择最符合原文的答案</p>
              <p className="quiz-question quiz-question--choice">{currentQuestion.prompt}</p>
              <div className="quiz-choices">
                {currentQuestion.options.map((option, optionIndex) => {
                  const answered = selectedOptionId !== null;
                  const correct = option.id === currentQuestion.correctOptionId;
                  const selected = option.id === selectedOptionId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className="quiz-choice"
                      data-correct={answered && correct ? 'true' : undefined}
                      data-wrong={answered && selected && !correct ? 'true' : undefined}
                      disabled={answered}
                      onClick={() => answerChoice(option.id)}
                    >
                      <span className="quiz-choice__index">{String.fromCharCode(65 + optionIndex)}</span>
                      <span>{option.text}</span>
                      {answered && correct && <Check size={17} />}
                      {answered && selected && !correct && <X size={17} />}
                    </button>
                  );
                })}
              </div>
              {selectedOptionId !== null && (
                <div
                  className="quiz-choice-feedback"
                  data-correct={selectedOptionId === currentQuestion.correctOptionId}
                >
                  <strong>
                    {selectedOptionId === currentQuestion.correctOptionId ? '回答正确，已记为掌握' : '回答错误，已标记为没记住'}
                  </strong>
                  <button type="button" className="glass-button" onClick={nextChoice}>
                    {index + 1 === total ? '查看结果' : '下一题'}
                    <ArrowRight size={15} />
                  </button>
                </div>
              )}
            </>
          ) : current ? (
            <>
              <p className="quiz-label">回忆</p>
              <p className="quiz-question">{current.question || `请复述「${current.title}」的要点。`}</p>

              {revealed ? (
                <>
                  <div className="quiz-answer">
                    <p className="quiz-label" style={{ marginBottom: 0 }}>原文答案</p>
                    {current.quoteStart >= 0 ? (
                      <p className="quiz-answer__quote">「{current.quote}」</p>
                    ) : (
                      <p className="quiz-answer__quote" style={{ color: 'var(--text-faint)' }}>
                        这个节点没有可逐字匹配的原句，无法展示可验证的答案。
                      </p>
                    )}
                    <div className="quiz-answer__text">
                      <span className="source-text" style={{ fontSize: 11.5 }}>
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
                  <p className="quiz-hint" style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 18, lineHeight: 1.9 }}>
                    先在心里回答，再对照原文那一句。不要急着看答案。
                  </p>
                  <div className="quiz-actions">
                    <button type="button" className="glass-button" onClick={() => setRevealed(true)}>
                      <Eye size={15} />
                      查看原文答案
                    </button>
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
