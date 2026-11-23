import type { KnowledgeDoc, KnowledgeNode } from './types';

/** 常见虚词，避免把整句拆出来的碎片都当成关键词 */
const STOP_WORDS = new Set([
  '的',
  '了',
  '和',
  '与',
  '在',
  '是',
  '我',
  '想',
  '要',
  '复习',
  '一下',
  '知识',
  '点',
  '这个',
  '那个',
  '什么',
  '怎么',
  '帮我',
  '请',
  '关于',
  '以及',
  '还有',
  '应该',
  '如何',
  '哪些',
  '进行',
]);

/** 把一句话拆成关键词：整段 + 中文二元组 + 英文/数字词 */
function tokenize(query: string): string[] {
  const normalized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!normalized) {
    return [];
  }
  const tokens = new Set<string>();
  for (const raw of normalized.split(/\s+/)) {
    if (!raw || STOP_WORDS.has(raw)) {
      continue;
    }
    tokens.add(raw);
    if (/[\u4e00-\u9fa5]/.test(raw) && raw.length > 2) {
      for (let i = 0; i < raw.length - 1; i += 1) {
        const gram = raw.slice(i, i + 2);
        if (!STOP_WORDS.has(gram)) {
          tokens.add(gram);
        }
      }
    }
  }
  return [...tokens];
}

function scoreNode(node: KnowledgeNode, tokens: string[]): number {
  const title = node.title.toLowerCase();
  const question = node.question.toLowerCase();
  const quote = node.quote.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) {
      score += 8;
    }
    if (question.includes(token)) {
      score += 3;
    }
    if (quote.includes(token)) {
      score += 1;
    }
  }
  return score;
}

/** 根据用户写下的知识点，在材料里挑出最相关的节点，用来生成复习卡片。 */
export function matchReviewNodes(
  doc: KnowledgeDoc | null,
  query: string,
  limit = 6,
): KnowledgeNode[] {
  if (!doc) {
    return [];
  }
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }
  return doc.nodes
    .map((node) => ({ node, score: scoreNode(node, tokens) }))
    .filter((item) => item.score >= 4)
    .sort((a, b) => b.score - a.score || a.node.level - b.node.level)
    .slice(0, limit)
    .map((item) => item.node);
}
