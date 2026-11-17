/**
 * 原文引用匹配。原则：宁可判定「无出处」，也不能把高亮放到错误的位置。
 *
 * 1. 逐字命中（indexOf）优先；
 * 2. 失败后用归一化文本匹配：忽略空白、全角/半角差异、标点；
 * 3. 归一化匹配时保留「归一化位置 → 原文位置」的映射，返回的区间始终落在原文上。
 */

export interface QuoteMatch {
  matched: boolean;
  exact: boolean;
  start: number;
  end: number;
}

const UNMATCHED: QuoteMatch = { matched: false, exact: false, start: -1, end: -1 };

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/;

function normalizeChar(char: string): string {
  let code = char.charCodeAt(0);
  // 全角 ASCII（！ 到 ～）转半角
  if (code >= 0xff01 && code <= 0xff5e) {
    return String.fromCharCode(code - 0xfee0).toLowerCase();
  }
  if (code === 0x3000) {
    return ' ';
  }
  return char.toLowerCase();
}

interface NormalizedText {
  text: string;
  map: number[];
}

export function normalizeQuoteText(source: string): NormalizedText {
  let text = '';
  const map: number[] = [];
  // 用 Array.from 处理代理对，避免把一个 emoji 拆成两半
  let offset = 0;
  for (const char of Array.from(source)) {
    const normalized = normalizeChar(char);
    const keep = !WHITESPACE.test(normalized) && !PUNCTUATION.test(normalized);
    if (keep && normalized.length > 0) {
      text += normalized;
      for (let i = 0; i < normalized.length; i += 1) {
        map.push(offset);
      }
    }
    offset += char.length;
  }
  return { text, map };
}

export function findQuote(source: string, quote: string): QuoteMatch {
  const raw = quote.trim();
  if (!raw) {
    return UNMATCHED;
  }

  const exactIndex = source.indexOf(raw);
  if (exactIndex >= 0) {
    return { matched: true, exact: true, start: exactIndex, end: exactIndex + raw.length };
  }

  const normalizedSource = normalizeQuoteText(source);
  const normalizedQuote = normalizeQuoteText(raw);
  if (!normalizedQuote.text) {
    return UNMATCHED;
  }

  const index = normalizedSource.text.indexOf(normalizedQuote.text);
  if (index < 0) {
    return UNMATCHED;
  }

  const start = normalizedSource.map[index];
  const lastIndex = index + normalizedQuote.text.length - 1;
  const end = normalizedSource.map[lastIndex] + 1;
  if (start === undefined || end === undefined || end <= start) {
    return UNMATCHED;
  }
  return { matched: true, exact: false, start, end };
}

/** 判断引用是否可以安全地高亮：必须逐字或归一化后能落在原文上 */
export function isVerbatimSource(source: string, quote: string): boolean {
  return findQuote(source, quote).matched;
}
