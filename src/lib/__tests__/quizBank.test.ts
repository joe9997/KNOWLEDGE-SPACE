import { describe, expect, it } from 'vitest';
import { buildChoiceQuestions } from '../quizBank';
import { normalizeQuoteText } from '../quotes';
import type { KnowledgeDoc, KnowledgeNode } from '../types';

function makeNode(
  id: string,
  quote: string,
  overrides: Partial<KnowledgeNode> = {},
): KnowledgeNode {
  return {
    id,
    title: `节点 ${id}`,
    question: `问题 ${id}`,
    quote,
    quoteStart: -1,
    quoteEnd: -1,
    parentId: null,
    level: 0,
    mastery: 0,
    goodStreak: 0,
    lastReviewedAt: null,
    nextReviewAt: 0,
    ...overrides,
  };
}

function makeDoc(text: string, nodes: KnowledgeNode[]): KnowledgeDoc {
  return {
    id: 'doc',
    title: '测试材料',
    text,
    origin: 'local',
    createdAt: 0,
    updatedAt: 0,
    nodes,
    relations: [],
  };
}

const BASE_DOC = makeDoc(
  ['原文甲。', '原文乙。', '原文丙。', '原文丁。', '原文戊。'].join('\n'),
  [
    makeNode('a', '原文甲。'),
    makeNode('b', '原文乙。'),
    makeNode('c', '原文丙。'),
    makeNode('d', '原文丁。'),
    makeNode('e', '原文戊。'),
  ],
);

function seededRandom(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

describe('buildChoiceQuestions', () => {
  it('按队列顺序出题，过滤不存在或无出处的节点并去重', () => {
    const doc = makeDoc(BASE_DOC.text, [
      makeNode('a', '原文甲。', { question: '甲的问题' }),
      makeNode('b', '原文乙。'),
      makeNode('c', '原文丙。', { title: '丙标题', question: '' }),
      makeNode('invalid', '材料中不存在。'),
    ]);

    const questions = buildChoiceQuestions(
      doc,
      ['missing', 'c', 'a', 'c', 'invalid', 'b', 'a'],
      () => 0.5,
    );

    expect(questions.map((question) => question.nodeId)).toEqual(['c', 'a', 'b']);
    expect(questions.map((question) => question.prompt)).toEqual([
      '请复述「丙标题」的要点。',
      '甲的问题',
      '问题 b',
    ]);
  });

  it('每题保留 2 至 4 个归一化后不同的选项，且只有一个正确项', () => {
    const doc = makeDoc(
      ['正确 原文，甲。', '正确原文甲', '干扰项一。', '干扰项一', '干扰项二。', '干扰项三。', '干扰项四。'].join('\n'),
      [
        makeNode('answer', '正确 原文，甲。', { quoteStart: 999, quoteEnd: 1000 }),
        makeNode('same-answer', '正确原文甲'),
        makeNode('distractor-a', '干扰项一。'),
        makeNode('same-distractor', '干扰项一'),
        makeNode('distractor-b', '干扰项二。'),
        makeNode('distractor-c', '干扰项三。'),
        makeNode('distractor-d', '干扰项四。'),
      ],
    );

    const [question] = buildChoiceQuestions(doc, ['answer'], () => 0.75);
    expect(question.options).toHaveLength(4);
    expect(new Set(question.options.map((option) => normalizeQuoteText(option.text).text)).size).toBe(4);

    const correctOptions = question.options.filter(
      (option) => option.id === question.correctOptionId,
    );
    expect(correctOptions).toHaveLength(1);
    expect(correctOptions[0]).toEqual({ id: 'answer', text: '正确 原文，甲。' });

    const twoSourceDoc = makeDoc('唯一甲。\n唯一乙。', [
      makeNode('a', '唯一甲。'),
      makeNode('b', '唯一乙。'),
    ]);
    const [twoOptionQuestion] = buildChoiceQuestions(twoSourceDoc, ['a'], () => 0);
    expect(twoOptionQuestion.options).toHaveLength(2);
  });

  it('干扰项优先同父节点，再选同层节点，最后选其余节点', () => {
    const doc = makeDoc(BASE_DOC.text, [
      makeNode('target', '原文甲。', { parentId: 'parent', level: 1 }),
      makeNode('other', '原文乙。', { parentId: 'other-parent', level: 4 }),
      makeNode('same-level', '原文丙。', { parentId: 'other-parent', level: 1 }),
      makeNode('sibling-b', '原文丁。', { parentId: 'parent', level: 3 }),
      makeNode('sibling-a', '原文戊。', { parentId: 'parent', level: 2 }),
    ]);

    const [question] = buildChoiceQuestions(doc, ['target'], () => 0.999999);
    expect(question.options.map((option) => option.id)).toEqual([
      'target',
      'sibling-b',
      'sibling-a',
      'same-level',
    ]);
  });

  it('空文档、无可溯源原文或全局不足两条不同原文时返回空数组', () => {
    expect(buildChoiceQuestions(makeDoc('', []), [], () => 0)).toEqual([]);

    const unmatched = makeDoc('实际材料。', [makeNode('a', '编造的原文。')]);
    expect(buildChoiceQuestions(unmatched, ['a'], () => 0)).toEqual([]);

    const oneDistinctText = makeDoc('同一原文。\n同一 原文。', [
      makeNode('a', '同一原文。'),
      makeNode('b', '同一 原文。'),
    ]);
    expect(buildChoiceQuestions(oneDistinctText, ['a', 'b'], () => 0)).toEqual([]);
  });

  it('固定随机序列可重复，Fisher-Yates 洗牌不固定正确项位置', () => {
    const first = buildChoiceQuestions(BASE_DOC, ['a', 'b'], seededRandom(42));
    const second = buildChoiceQuestions(BASE_DOC, ['a', 'b'], seededRandom(42));
    expect(first).toEqual(second);

    const [low] = buildChoiceQuestions(BASE_DOC, ['a'], () => 0);
    const [high] = buildChoiceQuestions(BASE_DOC, ['a'], () => 0.999999);
    expect(low.options.map((option) => option.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(high.options.map((option) => option.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
