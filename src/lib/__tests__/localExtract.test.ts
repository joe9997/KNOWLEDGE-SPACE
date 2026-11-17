import { describe, expect, it } from 'vitest';
import { extractLocally, toKnowledgeNodes } from '../localExtract';
import { findQuote } from '../quotes';

const HEADED = `# 合同法讲义

合同是当事人之间设立、变更、终止民事权利义务关系的协议。合同成立需要要约与承诺。

## 要约

要约是希望与他人订立合同的意思表示。要约到达受要约人时生效。

## 承诺

承诺是受要约人同意要约的意思表示。承诺生效时合同成立。`;

const PLAIN = `记忆分为感觉记忆、短时记忆与长时记忆。感觉记忆保持时间极短，通常不足一秒。
短时记忆的容量大约为七个组块。通过复述，短时记忆可以进入长时记忆。
长时记忆的提取依赖线索，线索越丰富，回忆越容易。`;

describe('本地规则整理', () => {
  it('按 Markdown 标题创建节点，引用是完整原句', () => {
    const extracted = extractLocally(HEADED);
    expect(extracted.length).toBeGreaterThanOrEqual(3);
    expect(extracted[0].title).toContain('合同法');
    expect(extracted[1].title).toBe('要约');
    extracted.forEach((node) => {
      expect(findQuote(HEADED, node.quote).matched).toBe(true);
    });
  });

  it('没有标题时按完整句子抽取', () => {
    const extracted = extractLocally(PLAIN);
    expect(extracted.length).toBeGreaterThanOrEqual(4);
    extracted.forEach((node) => {
      expect(findQuote(PLAIN, node.quote).matched).toBe(true);
      expect(node.question.length).toBeGreaterThan(4);
    });
  });

  it('补齐节点时建立父子层级', () => {
    const extracted = extractLocally(HEADED);
    const nodes = toKnowledgeNodes(extracted, HEADED, 1000);
    expect(nodes[0].parentId).toBeNull();
    const offer = nodes.find((node) => node.title === '要约');
    expect(offer?.parentId).toBe(nodes[0].id);
    nodes.forEach((node) => {
      expect(node.quoteStart).toBeGreaterThanOrEqual(0);
      expect(node.nextReviewAt).toBe(1000);
    });
  });

  it('无法逐字匹配的引用被标记为无出处', () => {
    const nodes = toKnowledgeNodes(
      [{ title: '编造节点', quote: '这句话不存在于材料中。', question: '测试？', level: 0 }],
      PLAIN,
      1000,
    );
    expect(nodes[0].quoteStart).toBe(-1);
    expect(nodes[0].quoteEnd).toBe(-1);
  });

  it('重复标题会生成唯一标题，避免覆盖', () => {
    const nodes = toKnowledgeNodes(
      [
        { title: '概念', quote: '感觉记忆保持时间极短，通常不足一秒。', question: '问？', level: 0 },
        { title: '概念', quote: '短时记忆的容量大约为七个组块。', question: '问？', level: 1 },
      ],
      PLAIN,
      1000,
    );
    expect(nodes[0].title).not.toBe(nodes[1].title);
  });
});
