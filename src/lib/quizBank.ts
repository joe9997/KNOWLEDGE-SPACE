import { findQuote, normalizeQuoteText } from './quotes';
import type { KnowledgeDoc, KnowledgeNode } from './types';

export type QuizMode = 'choice' | 'self';

export interface ChoiceQuestion {
  nodeId: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId: string;
}

interface SourceText {
  node: KnowledgeNode;
  text: string;
  normalized: string;
  /** 截取后的关键句，用于选项展示（避免选项过长变成阅读题） */
  keySentence: string;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 从 quote 里截取最有信息量的 1 句作为选项文本（最多 80 字） */
function extractKeySentence(quote: string, maxLen = 80): string {
  const clean = quote.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  const sentences = clean.split(/(?<=[。！？；.!?;])/).filter((s) => s.trim().length > 8);
  if (sentences.length === 0) return `${clean.slice(0, maxLen)}…`;
  const scored = sentences.map((s) => {
    let score = 0;
    if (/是指|指的是|称为|叫作|定义为|是一种|是一个/.test(s)) score += 5;
    if (/因为|所以|因此|由于|导致/.test(s)) score += 4;
    if (/例如|比如|举例/.test(s)) score += 3;
    if (/\d+/.test(s)) score += 2;
    if (s.length < 20) score -= 1;
    if (s.length > 140) score -= 1;
    return { s: s.trim(), score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].s;
  return best.length > maxLen ? `${best.slice(0, maxLen)}…` : best;
}

/** 计算两个选项文本的"视觉相似度"：长度越接近、结构越相似，区分度越高 */
function visualSimilarity(a: string, b: string): number {
  const lenDiff = Math.abs(a.length - b.length);
  const lenScore = Math.max(0, 100 - lenDiff * 2);
  // 都含数字 / 都含标点 / 都是疑问句等结构相似性
  let structScore = 0;
  if (/\d/.test(a) && /\d/.test(b)) structScore += 15;
  if (/是指|称为|定义为/.test(a) && /是指|称为|定义为/.test(b)) structScore += 20;
  if (/因为|所以/.test(a) && /因为|所以/.test(b)) structScore += 15;
  return lenScore + structScore;
}

export function buildChoiceQuestions(
  doc: KnowledgeDoc,
  nodeIds: string[],
  random = Math.random,
): ChoiceQuestion[] {
  const sources: SourceText[] = [];
  for (const node of doc.nodes) {
    const match = findQuote(doc.text, node.quote);
    if (!match.matched) {
      continue;
    }
    const text = doc.text.slice(match.start, match.end);
    const keySentence = extractKeySentence(text);
    if (!keySentence) continue;
    sources.push({ node, text, normalized: normalizeQuoteText(text).text, keySentence });
  }

  if (new Set(sources.map((source) => source.normalized)).size < 2) {
    return [];
  }

  const sourceById = new Map(sources.map((source) => [source.node.id, source]));
  const seen = new Set<string>();
  const questions: ChoiceQuestion[] = [];

  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) {
      continue;
    }
    seen.add(nodeId);

    const answer = sourceById.get(nodeId);
    if (!answer) {
      continue;
    }

    // 干扰项筛选：排除正确答案，按"视觉相似度"降序排序（越像正确答案的越适合当干扰项）
    const candidates = sources
      .filter(
        (source) => source.node.id !== nodeId && source.normalized !== answer.normalized,
      )
      .map((source) => ({
        source,
        similarity: visualSimilarity(answer.keySentence, source.keySentence),
      }))
      .sort((a, b) => b.similarity - a.similarity);

    const options = [{ id: answer.node.id, text: answer.keySentence }];
    const optionTexts = new Set([answer.normalized]);
    for (const { source: candidate } of candidates) {
      if (optionTexts.has(candidate.normalized)) {
        continue;
      }
      optionTexts.add(candidate.normalized);
      options.push({ id: candidate.node.id, text: candidate.keySentence });
      if (options.length === 4) {
        break;
      }
    }

    if (options.length < 2) {
      continue;
    }
    questions.push({
      nodeId,
      prompt: answer.node.question || `请复述「${answer.node.title}」的要点。`,
      options: shuffle(options, random),
      correctOptionId: answer.node.id,
    });
  }

  return questions;
}