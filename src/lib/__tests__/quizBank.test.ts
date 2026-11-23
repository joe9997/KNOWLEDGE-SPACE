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
    level: 1,
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

const BASE_TEXT = [
  '低精度值赋给高精度变量时会自动完成类型转换。',
  '高精度值赋给低精度变量时必须进行强制类型转换。',
  '字符串属于引用数据类型，分为 String 等。',
  '布尔类型只有 true 和 false 两个取值。',
  '整数类型的缺省类型是 int。',
].join('\n');

const BASE_DOC = makeDoc(BASE_TEXT, [
  makeNode('a', '低精度值赋给高精度变量时会自动完成类型转换。'),
  makeNode('b', '高精度值赋给低精度变量时必须进行强制类型转换。'),
  makeNode('c', '字符串属于引用数据类型，分为 String 等。'),
  makeNode('d', '布尔类型只有 true 和 false 两个取值。'),
  makeNode('e', '整数类型的缺省类型是 int。'),
]);

function seededRandom(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

describe('buildChoiceQuestions', () => {
  it('按队列顺序出题，过滤不存在或无出处的节点并去重', () => {
    const doc = makeDoc(BASE_TEXT, [
      makeNode('a', '低精度值赋给高精度变量时会自动完成类型转换。', { question: '甲的问题' }),
      makeNode('b', '高精度值赋给低精度变量时必须进行强制类型转换。'),
      makeNode('c', '字符串属于引用数据类型，分为 String 等。', {
        title: '丙标题',
        question: '',
      }),
      makeNode('invalid', '材料中不存在。'),
    ]);

    const questions = buildChoiceQuestions(
      doc,
      ['missing', 'c', 'a', 'c', 'invalid', 'b', 'a'],
      () => 0.5,
    );

    expect(questions.map((question) => question.nodeId)).toEqual(['a', 'b']);
    expect(questions.map((question) => question.prompt)).toEqual([
      '根据原文，下面哪一项正确说明了「节点 a」的规则或结果？',
      '根据原文，下面哪一项正确说明了「节点 b」的规则或结果？',
    ]);
  });

  it('中心主题（level 0）和章节标题不会作为答案或选项', () => {
    const doc = makeDoc(BASE_TEXT, [
      makeNode('root', '测试材料', { level: 0, title: '测试材料' }),
      makeNode('a', '低精度值赋给高精度变量时会自动完成类型转换。'),
      makeNode('b', '高精度值赋给低精度变量时必须进行强制类型转换。'),
    ]);

    const questions = buildChoiceQuestions(doc, ['root', 'a', 'b'], () => 0.5);
    expect(questions.map((question) => question.nodeId)).not.toContain('root');
    questions.forEach((question) => {
      question.options.forEach((option) => {
        expect(option.text).not.toBe('测试材料');
      });
    });
  });

  it('每题保留 2 至 4 个归一化后不同的选项，且只有一个正确项', () => {
    const doc = makeDoc(
      [
        '正确的原文甲，说明类型转换的基本规则。',
        '正确的原文甲说明类型转换的基本规则。',
        '干扰项一，说明强制转换的条件。',
        '干扰项一说明强制转换的条件。',
        '干扰项二，说明精度损失的风险。',
        '干扰项三，说明类型范围的限制。',
        '干扰项四，说明赋值相容的条件。',
      ].join('\n'),
      [
        makeNode('answer', '正确的原文甲，说明类型转换的基本规则。', {
          quoteStart: 999,
          quoteEnd: 1000,
        }),
        makeNode('same-answer', '正确的原文甲说明类型转换的基本规则。'),
        makeNode('distractor-a', '干扰项一，说明强制转换的条件。'),
        makeNode('same-distractor', '干扰项一说明强制转换的条件。'),
        makeNode('distractor-b', '干扰项二，说明精度损失的风险。'),
        makeNode('distractor-c', '干扰项三，说明类型范围的限制。'),
        makeNode('distractor-d', '干扰项四，说明赋值相容的条件。'),
      ],
    );

    const [question] = buildChoiceQuestions(doc, ['answer'], () => 0.75);
    expect(question.options).toHaveLength(4);
    expect(
      new Set(question.options.map((option) => normalizeQuoteText(option.text).text)).size,
    ).toBe(4);

    const correctOptions = question.options.filter(
      (option) => option.id === question.correctOptionId,
    );
    expect(correctOptions).toHaveLength(1);
    expect(correctOptions[0]).toEqual({
      id: 'answer',
      text: '正确的原文甲，说明类型转换的基本规则。',
    });

    const twoSourceDoc = makeDoc(
      '唯一甲句子，说明类型转换规则。\n唯一乙句子，说明赋值相容条件。',
      [
        makeNode('a', '唯一甲句子，说明类型转换规则。'),
        makeNode('b', '唯一乙句子，说明赋值相容条件。'),
      ],
    );
    const [twoOptionQuestion] = buildChoiceQuestions(twoSourceDoc, ['a'], () => 0);
    expect(twoOptionQuestion.options).toHaveLength(2);
  });

  it('只给带规则信号的节点出题，题目数量有上限', () => {
    const nodes = Array.from({ length: 12 }, (_, index) =>
      makeNode(`n${index}`, `第 ${index} 条规则说明类型转换的适用条件。`),
    );
    const doc = makeDoc(
      nodes.map((node) => node.quote).join('\n'),
      nodes,
    );
    const questions = buildChoiceQuestions(doc, nodes.map((node) => node.id), () => 0.3);
    expect(questions.length).toBeLessThanOrEqual(8);

    const looseDoc = makeDoc('这是一段没有规则信号的普通描述文字。', [
      makeNode('loose', '这是一段没有规则信号的普通描述文字。'),
    ]);
    expect(buildChoiceQuestions(looseDoc, ['loose'], () => 0)).toEqual([]);
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

  it('固定随机序列可重复，Fisher-Yates 洗牌会改变正确项位置', () => {
    const first = buildChoiceQuestions(BASE_DOC, ['a', 'b'], seededRandom(42));
    const second = buildChoiceQuestions(BASE_DOC, ['a', 'b'], seededRandom(42));
    expect(first).toEqual(second);

    const [low] = buildChoiceQuestions(BASE_DOC, ['a'], () => 0);
    const [high] = buildChoiceQuestions(BASE_DOC, ['a'], () => 0.999999);
    const lowIndex = low.options.findIndex((option) => option.id === low.correctOptionId);
    const highIndex = high.options.findIndex((option) => option.id === high.correctOptionId);
    expect(lowIndex).toBeGreaterThanOrEqual(0);
    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(lowIndex).not.toBe(highIndex);
  });
});
