import type { ExtractedNode } from './types.ts';
import { findQuote } from './quotes.ts';

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 100;
export const MAX_CHUNKS = 26;

export function chunkText(
  text: string,
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): Array<{ text: string; start: number }> {
  const chunks: Array<{ text: string; start: number }> = [];
  let start = 0;
  while (start < text.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(text.length, start + size);
    chunks.push({ text: text.slice(start, end), start });
    if (end >= text.length) {
      break;
    }
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export const PROMPT = `你是知识结构化助手。把用户提供的内容整理成带原文引用的层级大纲。

输出格式（严格遵守，只输出这些行，不要解释、不要代码块包裹）：
# 中心主题
## 节点标题 :: 原文中的一整句 :: 一个回忆问句
### 子节点标题 :: 原文中的一整句 :: 问句

硬性要求：
1. 用 # 的数量表示层级，最多 4 层。
2. 每行用 " :: " 分为三段：标题、原句引用、回忆问句。
3. 「原句引用」必须逐字摘自用户原文，不得改写、不得拼接两句。
4. 找不到可引用的原句时，该段写 "-"，不要编造。
5. 同级节点不超过 7 个，标题不超过 20 字。
6. 只使用原文出现的概念，不引入外部知识。
7. 问句要能单独回答，针对标题提问，不超过 30 字。

原文：
`;

export const SYSTEM_PROMPT = '你只输出符合约定的 Markdown 大纲，不输出解释或代码块。';

/** 解析 Markdown 层级输出。逐行容错，坏行只跳过，不丢整棵树。 */
export function parseExtraction(content: string): ExtractedNode[] {
  const lines = content.replace(/```[a-zA-Z]*/g, '').split(/\r?\n/);
  const nodes: ExtractedNode[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('```')) {
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (!heading) {
      continue;
    }
    const level = heading[1].length - 1;
    const body = heading[2];
    const parts = body.split(/\s*::\s*/);
    const title = (parts[0] ?? '').trim().replace(/^[*_`]+|[*_`]+$/g, '').slice(0, 20);
    if (!title) {
      continue;
    }
    const quoteRaw = (parts[1] ?? '').trim().replace(/^["“「']+|["”」']+$/g, '');
    // 中心主题行可以没有引用；此时用标题去原文中做逐字校验，匹配不到仍然是「无出处」
    const quote = parts.length < 2 ? title : quoteRaw === '-' ? '' : quoteRaw;
    const question = (parts[2] ?? '').trim() || `「${title}」的要点是什么？`;
    nodes.push({ title, quote, question, level: Math.min(3, level) });
  }
  return nodes;
}

/** 合并多块结果：按标题去重，优先保留能逐字命中原文的引用；只保留一个中心节点。 */
export function mergeExtractions(chunks: ExtractedNode[][], text: string): ExtractedNode[] {
  const merged: ExtractedNode[] = [];
  const seen = new Map<string, number>();
  for (const nodes of chunks) {
    for (const node of nodes) {
      const key = node.title.replace(/\s+/g, '').toLowerCase();
      if (seen.has(key)) {
        const index = seen.get(key)!;
        const existing = merged[index];
        if (!findQuote(text, existing.quote).matched && findQuote(text, node.quote).matched) {
          merged[index] = { ...existing, quote: node.quote };
        }
        continue;
      }
      seen.set(key, merged.length);
      merged.push({ ...node });
    }
  }
  // 跨 chunk 合并后只保留一个中心节点，其余同级根节点下沉一层
  merged.forEach((node, index) => {
    if (index > 0 && node.level === 0) {
      merged[index] = { ...node, level: 1 };
    }
  });
  return merged.slice(0, 40);
}
