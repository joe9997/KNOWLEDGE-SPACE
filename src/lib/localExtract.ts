import { createId } from './id';
import { findQuote } from './quotes';
import type { ExtractedNode, KnowledgeNode } from './types';

const MAX_LOCAL_NODES = 16;
const MAX_QUOTE_LENGTH = 220;

function stripHeadingMarks(line: string): string {
  return line.replace(/^\s*#{1,6}\s*/, '').replace(/\s*#+\s*$/, '').trim();
}

function firstSentence(section: string): string | null {
  const trimmed = section.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/[^。！？!?\n]+[。！？!?]/);
  const candidate = (match ? match[0] : trimmed.split('\n')[0]).trim();
  if (!candidate) {
    return null;
  }
  return candidate.length > MAX_QUOTE_LENGTH
    ? `${candidate.slice(0, MAX_QUOTE_LENGTH)}…`
    : candidate;
}

function shortTitle(text: string, max = 18): string {
  const clean = text
    .replace(/^[\s#>*\-+0-9.、]+/, '')
    .replace(/[，。；：、！？,.!?;:（）()「」《》“”"'']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, max) || '未命名节点';
}

function questionFor(title: string): string {
  const core = title.length > 20 ? title.slice(0, 20) : title;
  return `「${core}」的核心含义是什么？`;
}

interface Heading {
  index: number;
  end: number;
  level: number;
  title: string;
}

function findHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (match) {
      headings.push({
        index: offset,
        end: offset + line.length,
        level: match[1].length,
        title: stripHeadingMarks(line),
      });
    }
    offset += line.length + 1;
  }
  return headings;
}

function sentenceCandidates(text: string): string[] {
  const candidates: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    const body = paragraph.replace(/^\s*#{1,6}\s*/gm, '').trim();
    if (!body) {
      continue;
    }
    const matches = body.match(/[^。！？!?\n]+[。！？!?]/g);
    if (matches) {
      matches.forEach((sentence) => {
        const value = sentence.trim();
        if (value.length >= 8) {
          candidates.push(value);
        }
      });
    }
  }
  return candidates;
}

/**
 * 本地规则整理：完全不调用 AI。
 * - 有 Markdown 标题：标题作为节点标题，标题下第一句完整原句作为引用。
 * - 无标题：逐句抽取，句子作为原文引用，标题取句子开头。
 */
export function extractLocally(text: string): ExtractedNode[] {
  const headings = findHeadings(text);
  const extracted: ExtractedNode[] = [];

  if (headings.length > 0) {
    const first = headings[0];
    const firstSectionEnd = headings[1]?.index ?? text.length;
    const coreQuote = firstSentence(text.slice(first.end, firstSectionEnd)) ?? first.title;
    extracted.push({
      title: shortTitle(first.title),
      quote: coreQuote,
      question: questionFor(first.title),
      level: 0,
    });

    for (let i = 1; i < headings.length && extracted.length < MAX_LOCAL_NODES; i += 1) {
      const heading = headings[i];
      const nextIndex = headings[i + 1]?.index ?? text.length;
      const quote = firstSentence(text.slice(heading.end, nextIndex)) ?? heading.title;
      extracted.push({
        title: shortTitle(heading.title),
        quote,
        question: questionFor(heading.title),
        level: Math.min(3, Math.max(1, heading.level - first.level + 1)),
      });
    }
  } else {
    const sentences = sentenceCandidates(text);
    if (sentences.length === 0) {
      const fallback = text.trim().slice(0, 120);
      if (fallback) {
        extracted.push({
          title: shortTitle(fallback),
          quote: fallback,
          question: questionFor(fallback),
          level: 0,
        });
      }
    } else {
      extracted.push({
        title: shortTitle(sentences[0]),
        quote: sentences[0],
        question: questionFor(sentences[0]),
        level: 0,
      });
      for (let i = 1; i < sentences.length && extracted.length < MAX_LOCAL_NODES; i += 1) {
        extracted.push({
          title: shortTitle(sentences[i], 20),
          quote: sentences[i],
          question: questionFor(sentences[i]),
          level: 1,
        });
      }
    }
  }

  // 标题较少时，用正文完整句子补足节点，保证一段材料也能形成知识网络
  if (extracted.length > 0 && extracted.length < 8) {
    const quotes = new Set(extracted.map((node) => node.quote));
    const sentences = sentenceCandidates(text);
    for (const sentence of sentences) {
      if (extracted.length >= 8) {
        break;
      }
      if (quotes.has(sentence)) {
        continue;
      }
      quotes.add(sentence);
      extracted.push({
        title: shortTitle(sentence, 20),
        quote: sentence,
        question: questionFor(sentence),
        level: 1,
      });
    }
  }

  return extracted.slice(0, MAX_LOCAL_NODES);
}

/** 把抽取结果补齐为可复习节点，引用匹配失败时明确标记为无出处（-1） */
export function toKnowledgeNodes(
  extracted: ExtractedNode[],
  text: string,
  now = Date.now(),
): KnowledgeNode[] {
  const usedTitles = new Set<string>();
  const stack: Array<{ level: number; id: string }> = [];
  const nodes: KnowledgeNode[] = [];

  extracted.forEach((item, index) => {
    const match = findQuote(text, item.quote);
    let title = item.title.trim() || `节点 ${index + 1}`;
    let suffix = 2;
    while (usedTitles.has(title)) {
      title = `${item.title.trim()} ${suffix}`;
      suffix += 1;
    }
    usedTitles.add(title);

    const node: KnowledgeNode = {
      id: createId('node'),
      title,
      question: item.question || questionFor(title),
      quote: item.quote,
      quoteStart: match.matched ? match.start : -1,
      quoteEnd: match.matched ? match.end : -1,
      parentId: null,
      level: item.level,
      mastery: 0,
      goodStreak: 0,
      lastReviewedAt: null,
      nextReviewAt: now,
    };

    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    node.parentId = stack.length > 0 ? stack[stack.length - 1].id : null;
    stack.push({ level: node.level, id: node.id });
    nodes.push(node);
  });

  return nodes;
}
