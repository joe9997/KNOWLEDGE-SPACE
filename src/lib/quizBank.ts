import { findQuote, normalizeQuoteText } from './quotes';
import type { KnowledgeDoc, KnowledgeNode } from './types';

export type QuizMode = 'choice' | 'self';

export interface ChoiceQuestion {
  nodeId: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId: string;
  /** AI 出题时给出的答案依据；本地题库为空 */
  explanation?: string;
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

const GENERIC_TITLE = /^(例|举例|注意|同样|因此|所以|但是|而|并且|而且|概述|小结|总结|目录|更多)/;
/** 只有带规则信号的节点才值得出选择题；出不了好题就少出几道 */
const TESTABLE =
  /(转换|隐式|显式|强转|必须|不能|规则|是指|指的是|定义为|称为|分为|包括|区别|精度|范围|赋值|字节|带符号|大小)/;
const MAX_QUESTIONS = 8;

/** 判断一条原文能否当选项：太短、只有标题、以冒号结尾的残句都不行 */
function isUsableOption(text: string, title: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 14) {
    return false;
  }
  if (/[：:]$/.test(clean)) {
    return false;
  }
  // 没有句末标点的短行多半是表格项 / 后缀说明；数值表格行例外
  const numericRow = /\d/.test(clean) && /(字节|位|范围|带符号|~|-)/.test(clean);
  if (!numericRow && !/[。！？!?]/.test(clean) && clean.length < 40) {
    return false;
  }
  // 纯数值示例行不适合当选项
  if (/^[\d.]+[A-Za-z]?\s+/.test(clean) && !/(转换|必须|不能|规则|范围|精度)/.test(clean)) {
    return false;
  }
  const normalized = normalizeQuoteText(clean).text;
  return normalized !== normalizeQuoteText(title).text;
}

/** 题干太泛时，替换成能测规则理解的具体问法 */
function questionPrompt(node: KnowledgeNode, keySentence: string): string {
  const raw = (node.question || '').trim();
  const generic =
    !raw ||
    raw.length < 8 ||
    /可以分成哪几类|核心含义是什么|有哪些关键规则|说的是什么意思|原文给出的结论是什么/.test(
      raw,
    );
  if (!generic) {
    return raw;
  }
  if (/转换|隐式|显式|赋值/.test(`${node.title} ${keySentence}`)) {
    return `根据原文，下面哪一项正确说明了「${node.title}」的规则或结果？`;
  }
  return `根据原文，下面哪一项最符合「${node.title}」？`;
}

/** 把文本拆成用于匹配的词：英文/数字词 + 中文二元组 */
function matchTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const clean = text.toLowerCase().replace(/\s+/g, ' ');
  for (const word of clean.match(/[a-z][a-z0-9+#-]{1,}/g) ?? []) {
    terms.add(word);
  }
  for (const run of clean.replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/)) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  return terms;
}

function countShared(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const term of a) {
    if (b.has(term)) {
      count += 1;
    }
  }
  return count;
}

/** 表格型节点的类型名，如 long(长整形) → long */
function familyOf(title: string): string {
  return (title.match(/^([a-z][a-z0-9+#]{1,})/i)?.[1] ?? '').toLowerCase();
}

/** 干扰项相关性：同章节、同类型族、共享术语和数字才算相关 */
function relevance(
  answer: SourceText,
  candidate: SourceText,
  answerTerms: Set<string>,
  answerFamily: string,
): number {
  const candidateTerms = matchTerms(`${candidate.node.title} ${candidate.keySentence}`);
  const shared = countShared(answerTerms, candidateTerms);
  let score = shared * 2;
  if (
    answer.node.parentId &&
    candidate.node.parentId &&
    answer.node.parentId === candidate.node.parentId
  ) {
    score += 4;
  }
  const family = familyOf(candidate.node.title);
  if (answerFamily && family === answerFamily) {
    score += 5;
  }
  const answerHasNumber = /\d/.test(`${answer.node.title} ${answer.keySentence}`);
  const candidateHasNumber = /\d/.test(`${candidate.node.title} ${candidate.keySentence}`);
  if (answerHasNumber && candidateHasNumber) {
    score += 2;
  }
  return score;
}

export function buildChoiceQuestions(
  doc: KnowledgeDoc,
  nodeIds: string[],
  random = Math.random,
): ChoiceQuestion[] {
  const sources: SourceText[] = [];
  for (const node of doc.nodes) {
    // 中心主题（level 0）只作导航，不作为考点或干扰项
    if (node.level === 0 || GENERIC_TITLE.test(node.title.trim())) {
      continue;
    }
    const match = findQuote(doc.text, node.quote);
    if (!match.matched) {
      continue;
    }
    const text = doc.text.slice(match.start, match.end);
    const keySentence = extractKeySentence(text);
    if (!isUsableOption(keySentence, node.title)) {
      continue;
    }
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
    if (!TESTABLE.test(`${answer.node.title} ${answer.keySentence}`)) {
      continue;
    }

    // 干扰项筛选：先看是否同章节/同类型族/共享术语，再看长度结构是否相近
    const answerTerms = matchTerms(`${answer.node.title} ${answer.keySentence}`);
    const answerFamily = familyOf(answer.node.title);
    const candidates = sources
      .filter(
        (source) => source.node.id !== nodeId && source.normalized !== answer.normalized,
      )
      .map((source) => ({
        source,
        relevance: relevance(answer, source, answerTerms, answerFamily),
        similarity: visualSimilarity(answer.keySentence, source.keySentence),
      }))
      .filter((item) => item.relevance >= 4)
      .sort((a, b) => b.relevance - a.relevance || b.similarity - a.similarity);

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
      prompt: questionPrompt(answer.node, answer.keySentence),
      options: shuffle(options, random),
      correctOptionId: answer.node.id,
    });
  }

  return questions.slice(0, MAX_QUESTIONS);
}