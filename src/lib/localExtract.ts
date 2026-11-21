import { createId } from './id';
import { findQuote } from './quotes';
import type { ExtractedNode, KnowledgeNode } from './types';

const MAX_LOCAL_NODES = 16;
const MAX_QUOTE_LENGTH = 220;
const MIN_SENTENCE_LENGTH = 24;

/** 英文里这些缩写后面的句点不是句子结束 */
const ABBREVIATIONS = /(^|\s)(e\.g|i\.e|et al|etc|fig|figs|eq|eqs|sec|vs|dr|mr|ms|no)\.$/i;

const LATIN_CUES = [
  'we propose',
  'we present',
  'we introduce',
  'we show',
  'this paper',
  'in this work',
  'in this paper',
  'this work',
  'our method',
  'our approach',
  'results show',
  'experiments show',
  'experimental results',
  'we evaluate',
  'we demonstrate',
  'contribution',
  'key idea',
  'the proposed',
  'novel',
  'framework',
  'algorithm',
  'architecture',
  'dataset',
  'accuracy',
  'performance',
  'conclusion',
  'in summary',
  'we conclude',
];

const CN_CUES = [
  '提出',
  '方法',
  '实验',
  '结果',
  '表明',
  '基于',
  '通过',
  '实现',
  '设计',
  '包括',
  '主要',
  '结论',
  '特点',
  '定义',
  '分类',
  '关键',
  '能够',
  '可以',
  '因此',
  '核心',
];

const SECTION_BONUS: Record<string, number> = {
  abstract: 3,
  摘要: 3,
  introduction: 2,
  引言: 2,
  conclusion: 2.5,
  conclusions: 2.5,
  结论: 2.5,
  method: 1.5,
  methods: 1.5,
  方法: 1.5,
  results: 1.2,
  结果: 1.2,
};

const STOP_SECTION = /^(references?|bibliography|acknowledge?ments?|appendix|参考文献|致谢|附录)$/i;

/**
 * PDF 行尾断词修复：
 * - "en- able" / "im- proved" 这类短前缀直接拼回一个词
 * - "inertial- visual" / "multi- camera" 这类复合词保留连字符
 */
function joinBrokenWord(
  _match: string,
  before: string,
  after: string,
  offset: number,
  source: string,
): string {
  const prefix = `${source.slice(0, offset)}${before}`.match(/[A-Za-z]+$/)?.[0] ?? '';
  return `${before}${prefix.length <= 3 ? '' : '-'}${after}`;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/([A-Za-z])-\s*\n\s*([a-z])/g, joinBrokenWord)
    .replace(/([A-Za-z])-[ \t]+([a-z])/g, joinBrokenWord)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function stripHeadingMarks(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\s*#+\s*$/, '')
    .trim();
}

/** 按词边界截断，英文不会切断单词；中文优先在分句边界收尾并去掉裸露虚词 */
const DANGLING_TAIL = /(的|了|和|与|或|在|把|被|对|从|向|为|以|就|都|也|还|只|并且|而且|以及|及|等|如|是)$/;

function cutAtBoundary(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const clipped = text.slice(0, max);
  if (/[A-Za-z]/.test(clipped) && !/[\u4e00-\u9fa5]/.test(clipped)) {
    const space = clipped.lastIndexOf(' ');
    return (space > max * 0.45 ? clipped.slice(0, space) : clipped).trim();
  }
  // 中文：尽量切在标点/空格处，避免出现「…程序中的控」这种半截词
  const boundaries = ['，', '、', '：', '；', ',', ' ', '（', '(', '—', '–'];
  let cut = -1;
  for (const mark of boundaries) {
    cut = Math.max(cut, clipped.lastIndexOf(mark));
  }
  let out = cut > max * 0.45 ? clipped.slice(0, cut) : clipped;
  for (let round = 0; round < 4 && DANGLING_TAIL.test(out); round += 1) {
    out = out.replace(DANGLING_TAIL, '');
  }
  return out.trim();
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
    .replace(/[（(]\s*p\.?\s*\d+(\s*[-–~]\s*\d+)?\s*[)）]/gi, ' ')
    .replace(/^[\s#>*\-+0-9.、]+/, '')
    .replace(/^(this paper|in this work|in this paper|we|our|the)\s+/i, '')
    .replace(
      /^(proposes?|presents?|introduces?|describes?|reports?|shows?|demonstrates?|evaluates?|conducts?|designs?|develops?|collects?|collected|estimates?|formulates?|compares?|leverages?|achieves?|additionally|furthermore|moreover)\s+/i,
      '',
    )
    .replace(/^(a|an)\s+/i, '')
    .replace(/[，。；：、！？,.!?;:（）()「」《》“”"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) {
    return '未命名节点';
  }
  if (/^[\x20-\x7E]+$/.test(clean)) {
    const limit = Math.max(28, max * 1.9);
    const words = clean.split(' ');
    let result = '';
    for (const word of words) {
      const next = result ? `${result} ${word}` : word;
      if (next.length > limit) {
        break;
      }
      result = next;
    }
    const label = result || cutAtBoundary(clean, limit);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  return cutAtBoundary(clean, max) || '未命名节点';
}

const EN_DISCOURSE =
  /^(however|moreover|furthermore|therefore|thus|hence|besides|meanwhile|additionally|in addition|in this (?:section|paper|work|study)|as a result|overall|specifically|notably|in contrast|on the other hand|for example|for instance|first|second|third|finally|then|also|yet|still|to this end|in summary)[,:;]?\s+/i;

const CN_DISCOURSE =
  /^(然而|但是|但|因此|所以|此外|同时|另外|例如|比如|具体来说|总的来说|综上|首先|其次|最后|然后|而且|并且|不过|值得注意的是)[，,：:、]?\s*/;

const GENERIC_TITLE =
  /^(however|moreover|therefore|thus|meanwhile|however,|in this section|this section|it|this|these|those|result|results|method|methods|approach)$/i;

/** 去掉句首连接词，避免抽出 "However" / "In this section" 这种空标题 */
function stripDiscourse(text: string): string {
  let value = text.trim();
  for (let round = 0; round < 3; round += 1) {
    const next = value.replace(EN_DISCOURSE, '').replace(CN_DISCOURSE, '').trim();
    if (!next || next === value) {
      break;
    }
    value = next;
  }
  return value;
}

function titleFromSentence(sentence: string): string {
  const cleaned = stripDiscourse(
    sentence
      .replace(/^abstract\s*[—–:-]\s*/i, '')
      .replace(/^[\s"“'(\[]+/, '')
      .replace(/^\d+\)\s*/, '')
      // "To address these challenges, we present X" → 保留真正的主句
      .replace(
        /^to\s+(address|demonstrate|evaluate|verify|validate|solve|overcome|tackle)\b[^,]*,\s*/i,
        '',
      ),
  );
  const clauses = cleaned
    .split(/[，,;；:：—–]|\s+-\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  // 跳过只有一个虚词的分句，取第一个有实义内容的
  const meaningful = clauses.find(
    (clause) => /[\u4e00-\u9fa5]/.test(clause) || clause.split(/\s+/).length >= 2,
  );
  const candidate = shortTitle((meaningful ?? cleaned) || sentence, 20);
  if (GENERIC_TITLE.test(candidate)) {
    return shortTitle(stripDiscourse(sentence), 24);
  }
  return candidate;
}

/** 旧数据里可能存了 "However" / "In this section" 这类空标题，或数值/参数碎片 */
export function isWeakNodeTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length < 3 || GENERIC_TITLE.test(trimmed)) {
    return true;
  }
  const cjk = (trimmed.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  // 参数 / 常量碎片："E+306D 一个带有D 多余"、"2147483647 - 231"
  if (/\d{4,}/.test(trimmed) || /[A-Za-z][-+]?\d{2,}/.test(trimmed)) {
    const hasCue = /(是指|指的是|定义为|表示|包括|分为|用于|注意|必须|转换|类型|常量|变量)/.test(
      trimmed,
    );
    if (!hasCue && cjk <= 10) {
      return true;
    }
  }
  // 几乎全是符号，或只有一两个字
  if (cjk <= 2 && trimmed.length <= 6) {
    return true;
  }
  return false;
}

/** 用原文句子重新推导一个节点标题（不改动引用） */
export function deriveNodeTitle(quote: string, fallback = '未命名节点'): string {
  const direct = titleFromSentence(quote);
  if (direct && direct !== '未命名节点' && !isWeakNodeTitle(direct)) {
    return direct;
  }
  // 首个分句仍是碎片时，往后找一个「像知识点」的分句
  const clauses = quote
    .split(/[，,;；。！？!?\n]/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const better = clauses.find(
    (clause) =>
      clause.length >= 6 &&
      !/\d{4,}/.test(clause) &&
      !/[A-Za-z][-+]?\d{2,}/.test(clause) &&
      !isWeakNodeTitle(shortTitle(clause, 20)),
  );
  return better ? shortTitle(better, 22) : direct || fallback;
}

function questionFor(title: string, quote?: string): string {
  const text = quote || title;
  const core = title.length > 20 ? title.slice(0, 20) : title;

  // 按关键词生成更贴合的问句
  if (/定义|概念|是指|称为/.test(text)) {
    return `什么是「${core}」？请用自己的话解释它的核心要点。`;
  }
  if (/分类|类型|种类|分为|包括/.test(text)) {
    return `「${core}」可以分成哪几类？它们各自的特点是什么？`;
  }
  if (/方法|步骤|算法|流程|步骤|过程/.test(text)) {
    return `「${core}」的具体步骤或实现思路是什么？`;
  }
  if (/转换|转换|cast|强转|赋值|运算/.test(text)) {
    return `「${core}」在什么情况下会发生？需要注意什么？`;
  }
  if (/规则|语法|规范|要求|约束/.test(text)) {
    return `「${core}」有哪些关键规则或语法要点？`;
  }
  if (/区别|对比|vs|不同|差异|比较/.test(text)) {
    return `「${core}」和相关概念相比，最核心的区别是什么？`;
  }
  if (/作用|意义|影响|结果|效果|用途/.test(text)) {
    return `「${core}」的作用或实际意义是什么？`;
  }
  if (/例|示例|例子|example/i.test(text)) {
    return `请用「${core}」举一个例子，并说明为什么符合定义。`;
  }
  if (/true|false|判断|对错|正误/.test(text)) {
    return `关于「${core}」的说法，哪些是正确的，哪些是错误的？`;
  }

  // 兜底：如果 quote 本身是完整句子，直接针对 quote 提问
  if (quote && quote.length >= 20 && /[。.!?！？]$/.test(quote.trim())) {
    // 把陈述句转成问句：去掉结尾标点 + "是什么意思？"
    const stem = quote.trim().replace(/[。.!?！？]+$/, '');
    return `这句话"${stem.slice(0, 40)}${stem.length > 40 ? '…' : ''}"说的是什么意思？`;
  }

  return `「${core}」的核心含义是什么？`;
}

/**
 * 本地兜底讲解：不依赖 AI，从 title + quote 拼出一段可读的讲解。
 * 格式：先一句话概括 → 再把 quote 里的核心词加粗 → 最后点出用途/注意点。
 * 如果 quote 太短或空，就退化成标题改写。
 */
function synthesizeLocalExplanation(title: string, quote: string): string {
  const t = stripDiscourse(title).trim();
  const q = quote.replace(/\s+/g, ' ').trim();
  if (!q) {
    return `**${t || '该概念'}** 暂无讲解内容，可以回到原文补充。`;
  }

  const rawParts = splitChineseSentence(q);
  const boldTargets = new Set(pickBoldIndices(rawParts, q).map((i) => rawParts[i]));
  const parts = rawParts.map((p) => p.trim()).filter((p) => p.length >= 2);
  const firstClause = parts[0] ?? q;
  const leadName = t || firstClause;

  // ① 一句话定义
  const lead = `**${leadName}**：${firstClause}${/[。！？.!?]$/.test(firstClause) ? '' : '。'}`;

  // ② 展开要点：其余分句逐条列出，关键术语加粗
  const seen = new Set([firstClause]);
  const bullets: string[] = [];
  for (const part of parts.slice(1)) {
    if (bullets.length >= 4) break;
    if (seen.has(part)) continue;
    seen.add(part);
    bullets.push(`- ${boldTargets.has(part) ? `**${part}**` : part}`);
  }

  // ③ 复习提示：按内容类型给出针对性提醒
  const tips: string[] = [];
  const scope = `${t} ${q}`;
  if (/转换/.test(scope)) {
    tips.push('💡 抓两头：**源类型**是什么、**目标类型**是什么，转换时是否丢失精度。');
  }
  if (/必须|注意|不能|不允许|丢失|精度|范围/.test(q)) {
    tips.push('⚠️ 这句话里有**硬性约束**，考试和写代码时最容易踩坑。');
  }
  if (/包括|分为|共有|组成/.test(q)) {
    tips.push('🧩 这是一个**分类/枚举**型知识点，回忆时先列全再逐个解释。');
  }
  if (/例|示例|例如/.test(q)) {
    tips.push('💡 结合例子记忆，比背定义更牢。');
  }
  if (tips.length === 0) {
    tips.push('🔍 回顾时试着用自己的话复述一遍，能说清就是真会了。');
  }

  const blocks = [lead];
  if (bullets.length > 0) {
    blocks.push(bullets.join('\n'));
  }
  blocks.push(tips.join('\n'));
  return blocks.join('\n\n');
}

/** 供旧数据迁移使用：用本地规则重建某个节点的讲解 */
export function rebuildLocalExplanation(title: string, quote: string): string {
  return synthesizeLocalExplanation(title, quote);
}

/** 把中文句子按标点拆成片段，英文按空格 + 标点拆 */
function splitChineseSentence(text: string): string[] {
  const clean = text.replace(/^\s+|\s+$/g, '');
  if (!clean) return [];
  // 中英文混合拆分：先按中文标点拆，再对每个片段按英文单词拆
  const byCN = clean.split(/([，。；：、（）\(\)])/).filter(Boolean);
  const result: string[] = [];
  for (const segment of byCN) {
    if (/^[，。；：、（）\(\)]$/.test(segment)) {
      // 标点附加到上一个片段
      if (result.length > 0) result[result.length - 1] += segment;
      else result.push(segment);
      continue;
    }
    // 英文部分：按空格拆
    if (/[A-Za-z]/.test(segment)) {
      const words = segment.match(/[A-Za-z_][A-Za-z0-9_]*[^A-Za-z0-9_]*/g) ?? [segment];
      result.push(...words.filter(Boolean));
    } else {
      result.push(segment);
    }
  }
  return result.filter((p) => p.trim().length > 0);
}

/** 从片段里挑 1-2 个最值得加粗的：包含关键动词/名词 或 最长的非标点片段 */
function pickBoldIndices(parts: string[], _quote: string): number[] {
  if (parts.length <= 1) return [];
  const keywordSet = new Set([
    '定义', '概念', '方法', '规则', '类型', '转换', '强制', '自动', '精度', '类型',
    '必须', '赋值', '运算', '结果', '包含', '包括', '称为', '作用',
    'Java', 'int', 'byte', 'short', 'long', 'float', 'double', 'char', 'boolean',
    'JVM', 'API', 'IDE', 'UTF', 'ASCII', 'Unicode',
  ]);
  const scored = parts
    .map((part, index) => {
      let score = 0;
      if (keywordSet.has(part)) score += 5;
      if (keywordSet.has(part.toLowerCase())) score += 5;
      // 代码风格 (大小写混合) 优先加粗
      if (/[A-Z][a-z]/.test(part) && part.length >= 2) score += 4;
      // 足够长的中文片段
      if (/[\u4e00-\u9fa5]/.test(part) && part.length >= 3 && part.length <= 10) score += 2;
      // 纯数字跳过
      if (/^\d+$/.test(part)) score -= 10;
      return { index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const picked = scored.filter((s) => s.score > 0).slice(0, 2);
  // 兜底：挑最长的 1 个片段（不是纯标点或数字）
  if (picked.length === 0) {
    const fallback = parts
      .map((part, index) => ({ index, len: part.replace(/[，。；：、（）\(\)\s\d]/g, '').length }))
      .filter((p) => p.len >= 3)
      .sort((a, b) => b.len - a.len || a.index - b.index);
    if (fallback.length > 0) picked.push({ index: fallback[0].index, score: 1 });
  }

  return picked.map((p) => p.index);
}

interface Heading {
  index: number;
  end: number;
  level: number;
  title: string;
}

/** 当 quote 为空或未匹配时，用 title 作为锚点在原文里找一个替代引用 */
function findQuoteByTitle(text: string, title: string): { text: string; start: number; end: number } | null {
  const t = title.trim();
  if (!t || t.length < 2) return null;

  // 尝试 1: 直接在原文里找 title，然后取它后面的第一句
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(escaped, '');
  let idx = direct.test(text) ? text.search(direct) : -1;

  // 尝试 2: title 的第一个实词片段（去掉"2.1.3"/"第"/"章"等前缀）
  if (idx < 0) {
    const clean = t.replace(/^[0-9.一二三四五六七八九十第章节\s]+/, '').trim();
    if (clean.length >= 2) {
      const cleanEscaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      idx = text.search(new RegExp(cleanEscaped));
    }
  }

  if (idx < 0) return null;

  // 取 title 之后第一句作为 quote（最多 200 字）
  const after = text.slice(idx + t.length);
  const firstSentenceEnd = after.search(/[。！？.!?]/);
  const sentence =
    firstSentenceEnd >= 0
      ? after.slice(0, firstSentenceEnd + 1).trim()
      : after.slice(0, 120).trim();

  if (sentence.length < 6) return null;
  return {
    text: sentence,
    start: idx + t.length,
    end: idx + t.length + sentence.length,
  };
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
  const paragraphs = normalizeText(text).split(/\n{2,}/);
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

/** 识别 Markdown 标题、论文编号章节与常见章节名 */
function asHeading(line: string): { level: number; title: string } | null {
  const md = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
  if (md) {
    return { level: md[1].length - 1, title: stripHeadingMarks(line) };
  }
  const numbered = line.match(/^\s*(\d+(?:\.\d+)*)\.?\s+([A-Z][A-Za-z0-9 ,:'’\-/().&]{2,70})$/);
  if (numbered && !/[.!?,;]$/.test(line)) {
    return {
      level: Math.min(3, numbered[1].split('.').length - 1),
      title: numbered[2].trim(),
    };
  }
  const named = line.match(
    /^\s*(abstract|introduction|related work|background|method|methods|approach|experiments?|results?|evaluation|discussion|conclusions?|limitations|references|摘要|引言|相关工作|方法|实验|结果|讨论|结论|参考文献)\s*$/i,
  );
  if (named) {
    return { level: 0, title: named[1] };
  }
  return null;
}

interface Block {
  kind: 'heading' | 'body';
  text: string;
  level: number;
  section: string;
}

function parseBlocks(text: string): Block[] {
  const lines = normalizeText(text).split('\n');
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let section = '';

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    // PDF 的硬换行先按行切开；只有小写开头的续行才接回上一行
    const merged: string[] = [];
    for (const raw of buffer) {
      const line = raw.trim();
      if (!line) {
        continue;
      }
      if (merged.length === 0) {
        merged.push(line);
        continue;
      }
      const prev = merged[merged.length - 1];
      // 只有「上一行很长且明显没说完」才把下一行接回去；PPT 的短词条不能被粘成一坨
      const continues =
        /^[a-z(“"']/.test(line) && !/[.!?。！？:;]$/.test(prev) && prev.length >= 60;
      if (continues) {
        merged[merged.length - 1] = `${prev} ${line}`;
      } else {
        merged.push(line);
      }
    }
    for (const body of merged) {
      blocks.push({ kind: 'body', text: body, level: 0, section });
    }
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = asHeading(line);
    if (heading) {
      flush();
      section = heading.title;
      blocks.push({ kind: 'heading', text: heading.title, level: heading.level, section });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return blocks;
}

function splitSentences(paragraph: string): string[] {
  const text = paragraph.trim();
  if (!text) {
    return [];
  }
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const cjkEnd = char === '。' || char === '！' || char === '？';
    const latinEnd = char === '.' || char === '!' || char === '?';
    if (!cjkEnd && !latinEnd) {
      continue;
    }
    if (char === '.') {
      // 3.14 / 1.2.3 这类小数与版本号不切
      if (/\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? '')) {
        continue;
      }
      const head = text.slice(Math.max(0, index - 12), index + 1);
      if (ABBREVIATIONS.test(head)) {
        continue;
      }
    }
    const next = text[index + 1] ?? '';
    if (latinEnd && next && !/[\s"'”’)\]]/.test(next)) {
      continue;
    }
    const sentence = text.slice(start, index + 1).trim();
    if (sentence) {
      sentences.push(sentence);
    }
    start = index + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) {
    sentences.push(tail);
  }
  return sentences;
}

interface Candidate {
  text: string;
  index: number;
  score: number;
  section: string;
}

/** 中文句子天然更短，按语种使用不同下限 */
function isTooShort(sentence: string): boolean {
  const min = /[\u4e00-\u9fa5]/.test(sentence) ? 12 : MIN_SENTENCE_LENGTH;
  return sentence.length < min;
}

function looksLikeNoise(sentence: string): boolean {
  if (isTooShort(sentence)) {
    return true;
  }
  if (/@|https?:\/\/|doi\.org|arxiv:/i.test(sentence)) {
    return true;
  }
  // 图表 / 算法标题、作者信息、基金与致谢
  if (/^(fig\.|figure|table|algorithm|equation|图|表)\s*[0-9ivx]+/i.test(sentence)) {
    return true;
  }
  if (
    /recommended for publication|supported by|funding|grant (no|number)|corresponding author|authors? thank|manuscript received|digital object identifier/i.test(
      sentence,
    )
  ) {
    return true;
  }
  // PDF 断行留下的续句通常以小写开头（但含中文的行是 PPT 词条，如 "char 常量是用单引号括起来"）
  if (/^[a-z]/.test(sentence) && !/[\u4e00-\u9fa5]/.test(sentence)) {
    return true;
  }
  if (/^[\d\s.,;:+\-–—%/()]+$/.test(sentence)) {
    return true;
  }
  // 纯英文句子里字母占比过低，多半是符号 / 公式碎片
  if (/^[\x20-\x7E]+$/.test(sentence)) {
    const letters = sentence.replace(/[^A-Za-z]/g, '').length;
    if (letters / sentence.length < 0.55) {
      return true;
    }
  }

  // ---- PPT / 讲义碎片过滤 ----
  const cjkCount = (sentence.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const symbolCount = (sentence.match(/[~+\-=<>*/%^|\\[\]]/g) ?? []).length;
  // 数值范围、十六进制、表达式碎片："~ 2147483647 - 231 --"、"E+306D 一个带有D 多余"
  if (cjkCount < 6 && symbolCount >= 2) {
    return true;
  }
  // 页码与章节编号："2.1.3 不同类型数据之间转换(p29-30)"、"(p29-30)"
  if (/\(\s*p\.?\s*\d+(\s*[-–~]\s*\d+)?\s*\)\s*$/i.test(sentence) && cjkCount < 10) {
    return true;
  }
  if (/^(p\.?\s*\d+|第\s*\d+\s*页)/i.test(sentence)) {
    return true;
  }
  // 孤立符号或一两个字的残句："、"，"如"，"例"
  if (cjkCount > 0 && cjkCount <= 2 && sentence.trim().length <= 4) {
    return true;
  }
  // 纯数字 / 十六进制 / 浮点字面量
  if (/^[-+]?(0x[0-9a-fA-F]+|\d+(\.\d+)?([eE][-+]?\d+)?[dDfFlL]?)$/.test(sentence.trim())) {
    return true;
  }
  // 参数 / 常量碎片："E+306D 一个带有D 多余"、"最大值 2147483647"
  if (
    /[A-Za-z][-+]?\d{2,}|\d{4,}/.test(sentence) &&
    !/(是指|指的是|定义为|表示|包括|分为|用于|注意|必须)/.test(sentence) &&
    cjkCount <= 10
  ) {
    return true;
  }
  return false;
}

function sectionWeight(section: string): number {
  const key = section.toLowerCase().trim();
  return SECTION_BONUS[key] ?? 0;
}

function scoreSentence(sentence: string, order: number, total: number, section: string): number {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const cue of LATIN_CUES) {
    if (lower.includes(cue)) {
      score += 2;
    }
  }
  for (const cue of CN_CUES) {
    if (sentence.includes(cue)) {
      score += 1.6;
    }
  }
  const length = sentence.length;
  if (length >= 60 && length <= 180) {
    score += 1.4;
  } else if (length < 36) {
    score -= 1.2;
  }
  if (/\d+(\.\d+)?\s*(%|ms|cm|mm|m|fps|°|度)?/.test(sentence)) {
    score += 0.6;
  }
  score += sectionWeight(section);
  // 摘要 / 引言 / 结论的句子优先，但仍保留文中的关键方法句
  score += (1 - order / Math.max(1, total)) * 1.2;
  if (/^(this paper|in this work|we propose|we present|本文|我们提出)/i.test(sentence)) {
    score += 1.2;
  }
  // 中文定义 / 分类 / 规则陈述，最像知识点
  if (/(是指|指的是|定义为|表示|包括|分为|共有|由.{0,8}组成|用于|作用|特点|区别|规则|注意|必须|不能)/.test(sentence)) {
    score += 1.2;
  }
  // 代码示例行（大量括号/分号/等号）降权，避免把代码当知识点
  if ((sentence.match(/[=;{}()]/g) ?? []).length >= 4) {
    score -= 1.6;
  }
  return score;
}

function collectCandidates(text: string): Candidate[] {
  const blocks = parseBlocks(text);
  const candidates: Candidate[] = [];
  let stopped = false;
  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (STOP_SECTION.test(block.text.trim())) {
        stopped = true;
        break;
      }
      continue;
    }
    if (stopped) {
      continue;
    }
    const sentences = splitSentences(block.text);
    for (const sentence of sentences) {
      if (looksLikeNoise(sentence)) {
        continue;
      }
      const trimmed =
        sentence.length > MAX_QUOTE_LENGTH ? sentence.slice(0, MAX_QUOTE_LENGTH) : sentence;
      candidates.push({ text: trimmed, index: candidates.length, score: 0, section: block.section });
    }
  }

  return candidates.map((candidate, index) => ({
    ...candidate,
    index,
    score: scoreSentence(candidate.text, index, candidates.length, candidate.section),
  }));
}

/** 取若干条最像「要点」的句子，保持原文顺序 */
function pickKeySentences(text: string, limit: number): string[] {
  const candidates = collectCandidates(text);
  if (candidates.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const picked = [...candidates]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter((candidate) => {
      const key = candidate.text.replace(/\s+/g, ' ').trim().toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .sort((a, b) => a.index - b.index);
  return picked.map((candidate) => candidate.text);
}

/** 摘要按句子边界截断，避免半句话 */
function truncateSummary(text: string, max = 190): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return '';
  }
  if (cleaned.length <= max) {
    return cleaned;
  }
  const clipped = cleaned.slice(0, max);
  const boundary = Math.max(
    clipped.lastIndexOf('。'),
    clipped.lastIndexOf('！'),
    clipped.lastIndexOf('？'),
    clipped.lastIndexOf('. '),
  );
  if (boundary > max * 0.45) {
    return `${clipped.slice(0, boundary + 1).trim()}…`;
  }
  const space = clipped.lastIndexOf(' ');
  return `${(space > max * 0.5 ? clipped.slice(0, space) : clipped).trim()}…`;
}

/**
 * 自动生成文档级信息：
 * - subtitle：论文/讲义标题或正文首句
 * - summary：Abstract 段落或文中得分最高的两句话
 */
export function buildDocMeta(text: string): { subtitle: string; summary: string } {
  // 标题与摘要总在文首，长文档只扫前 8 万字，避免导入百万字时卡顿
  const source = text.slice(0, 80_000);
  const lines = normalizeText(source)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const abstractIndex = lines.findIndex(
    (line) => /^abstract\b/i.test(line) || /^摘\s*要/.test(line),
  );
  const preamble = abstractIndex >= 0 ? lines.slice(0, abstractIndex) : lines.slice(0, 4);

  const usable = preamble.filter((line) => {
    if (line.length < 8 || line.length > 180) {
      return false;
    }
    if (/@|https?:\/\/|doi\.org|arxiv:/i.test(line)) {
      return false;
    }
    // 期刊页眉、版权行、投稿状态
    if (/preprint|accepted|proceedings|journal|issn|copyright|©|\bvol\.|\bno\./i.test(line)) {
      return false;
    }
    if (/\b(university|institute|department|laboratory|college)\b/i.test(line)) {
      return false;
    }
    if (/^[\d\s.,;:+\-–—%/()]+$/.test(line)) {
      return false;
    }
    return true;
  });
  // 论文/讲义标题通常带冒号；没有就取最长的一行，避免抓到作者行
  const titled = usable.find((line) => line.includes(':') && line.length >= 12);
  const longest = [...usable].sort((a, b) => b.length - a.length)[0];

  let subtitle = '';
  const chosen = titled ?? longest;
  if (chosen) {
    // 论文标题在 PDF 里常被折成两三行，向后拼接续行直到遇到作者/单位
    let merged = chosen;
    const start = preamble.indexOf(chosen);
    for (let index = start + 1; index >= 1 && index < preamble.length; index += 1) {
      const next = preamble[index];
      if (merged.length >= 110 || merged.length + next.length > 118) {
        break;
      }
      if (!next || next.length < 4 || next.length > 90) {
        break;
      }
      if (/\d|@|https?:\/\//.test(next)) {
        break;
      }
      if (/\b(university|institute|department|laboratory|college)\b/i.test(next)) {
        break;
      }
      if (/[.:]$/.test(merged)) {
        break;
      }
      merged = `${merged} ${next}`;
    }
    const cleaned = merged.replace(/^\d+(?:\.\d+)*\.?\s*/, '');
    // 像标题（带冒号、无句末标点）就保留完整一行；正文则只取第一句当副标题
    const looksLikeTitle = /[:：]/.test(cleaned) && !/[。.!?！？]$/.test(cleaned);
    const base = looksLikeTitle ? cleaned : firstSentence(cleaned) ?? cleaned;
    subtitle = cutAtBoundary(base, looksLikeTitle ? 140 : 64);
  }

  if (!subtitle) {
    const candidates = collectCandidates(source);
    subtitle = candidates.length > 0 ? cutAtBoundary(candidates[0].text, 56) : '';
  }

  let summary = '';
  if (abstractIndex >= 0) {
    const abstractLines: string[] = [];
    for (let index = abstractIndex; index < lines.length && abstractLines.length < 6; index += 1) {
      if (index > abstractIndex && asHeading(lines[index])) {
        break;
      }
      abstractLines.push(lines[index]);
    }
    const rest = abstractLines.join(' ').replace(/^abstract\s*[—–:-]?\s*/i, '');
    summary = truncateSummary(rest);
  }
  if (!summary) {
    summary = truncateSummary(pickKeySentences(source, 2).join(' '));
  }

  return { subtitle, summary };
}

const VOCAB_LINE = /^([A-Za-z][A-Za-z'\- ]{1,24})\s*\/[^/\n]{2,}\/\s*(?:v|n|adj|adv|prep|conj|pron|phr)\./i;

/**
 * 从粘贴内容自动总结一个标题：
 * - Markdown 标题优先
 * - 单词表 → 「英语精读：word1、word2」
 * - 双语对照 → 「双语笔记：首句译文」
 * - 其他 → 论文/讲义标题或首句
 */
export function deriveDocTitle(text: string): string {
  const heading = text.match(/^\s*#{1,6}\s+(.+)$/m);
  if (heading) {
    return cutAtBoundary(heading[1].trim(), 44);
  }

  const vocab = [
    ...new Set(
      [...text.matchAll(new RegExp(VOCAB_LINE.source, 'gim'))]
        .map((match) => match[1].trim())
        .filter(Boolean),
    ),
  ];
  if (vocab.length >= 2) {
    return `英语精读：${vocab.slice(0, 3).join('、')}`.slice(0, 44);
  }

  const translations = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(译文|翻译)[：:]/.test(line))
    .map((line) => line.replace(/^(译文|翻译)[：:]\s*/, ''));
  if (translations.length >= 2) {
    return `双语笔记：${cutAtBoundary(translations[0], 18)}`;
  }

  const meta = buildDocMeta(text);
  if (meta.subtitle) {
    return cutAtBoundary(meta.subtitle, 44);
  }

  const firstLine = text.split('\n').find((line) => line.trim())?.trim() ?? '';
  return cutAtBoundary(firstLine, 28) || '未命名材料';
}

/**
 * 本地规则整理：完全不调用 AI。
 * - 有 Markdown 标题：标题作为节点标题，标题下第一句完整原句作为引用。
 * - 无标题：中英文句子切分 + 章节权重 + 要点打分，抽取 8–16 个要点。
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
      question: questionFor(first.title, coreQuote),
      level: 0,
    });

    for (let i = 1; i < headings.length && extracted.length < MAX_LOCAL_NODES; i += 1) {
      const heading = headings[i];
      const nextIndex = headings[i + 1]?.index ?? text.length;
      const quote = firstSentence(text.slice(heading.end, nextIndex)) ?? heading.title;
      extracted.push({
        title: shortTitle(heading.title),
        quote,
        question: questionFor(heading.title, quote),
        level: Math.min(3, Math.max(1, heading.level - first.level + 1)),
      });
    }
  } else {
    const candidates = collectCandidates(text);
    if (candidates.length === 0) {
      const fallback = text.trim().slice(0, 120);
      if (fallback) {
        extracted.push({
          title: shortTitle(fallback),
          quote: fallback,
          question: questionFor(fallback, fallback),
          level: 0,
        });
      }
    } else {
      const seen = new Set<string>();
      const picked = [...candidates]
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .filter((candidate) => {
          const key = candidate.text.replace(/\s+/g, ' ').trim().toLowerCase();
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .slice(0, MAX_LOCAL_NODES)
        .sort((a, b) => a.index - b.index);

      picked.forEach((candidate, index) => {
        const title = titleFromSentence(candidate.text);
        extracted.push({
          title,
          quote: candidate.text,
          question: questionFor(title, candidate.text),
          level: index === 0 ? 0 : 1,
        });
      });
    }
  }

  // 标题较少时，用正文完整句子补足节点，保证一段材料也能形成知识网络
  if (extracted.length > 0 && extracted.length < 8) {
    const quotes = new Set(extracted.map((node) => node.quote));
    const sentences = [
      ...collectCandidates(text).map((candidate) => candidate.text),
      ...sentenceCandidates(text),
    ];
    for (const sentence of sentences) {
      if (extracted.length >= 8) {
        break;
      }
      if (quotes.has(sentence) || isTooShort(sentence)) {
        continue;
      }
      quotes.add(sentence);
      extracted.push({
        title: titleFromSentence(sentence),
        quote: sentence,
        question: questionFor(titleFromSentence(sentence), sentence),
        level: 1,
      });
    }
  }

  return extracted.slice(0, MAX_LOCAL_NODES);
}

/** 把抽取结果补齐为可复习节点，引用匹配失败时尝试用标题附近的正文回源 */
export function toKnowledgeNodes(
  extracted: ExtractedNode[],
  text: string,
  now = Date.now(),
): KnowledgeNode[] {
  const usedTitles = new Set<string>();
  const stack: Array<{ level: number; id: string }> = [];
  const nodes: KnowledgeNode[] = [];

  extracted.forEach((item, index) => {
    let quote = item.quote.trim();
    let match = findQuote(text, quote);

    // 兜底 1：quote 为空或未匹配 → 用 title 在原文里找最近的句子
    if (quote.length < 6 || !match.matched) {
      const fallback = findQuoteByTitle(text, item.title);
      if (fallback) {
        quote = fallback.text;
        match = { matched: true, exact: false, start: fallback.start, end: fallback.end };
      }
    }

    // 兜底 2：仍然没匹配 → 让 quote 里至少有内容（AI 写的，即使无出处也展示）
    if (quote.length < 6 && item.title.length >= 2) {
      quote = `${item.title}：${item.quote || ''}`.trim();
    }

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
      question: item.question || questionFor(title, quote),
      quote,
      quoteStart: match.matched ? match.start : -1,
      quoteEnd: match.matched ? match.end : -1,
      parentId: null,
      level: item.level,
      mastery: 0,
      goodStreak: 0,
      lastReviewedAt: null,
      nextReviewAt: now,
      explanation: synthesizeLocalExplanation(title, quote),
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
