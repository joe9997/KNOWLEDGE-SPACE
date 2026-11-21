import { getToken, resolveApiUrl } from './auth';
import { isDue } from './review';
import type { ApiConfig, KnowledgeDoc } from './types';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface OutgoingChatMessage {
  role: 'user' | 'assistant';
  content: string | ChatContentPart[];
}

const MAX_CONTEXT_CHARS = 6000;
const MAX_NODE_CHARS = 600;

/**
 * 神经中枢式上下文：当前会话给足细节，其他会话给主题 + 摘要 + 关键点。
 * 这样用户问「XX 在别的材料里怎么讲」时，模型能跨会话回答。
 */
export function buildKnowledgeContext(
  docs: KnowledgeDoc[],
  activeDoc: KnowledgeDoc | null,
): string {
  if (docs.length === 0 && !activeDoc) {
    return '';
  }
  const lines = [`知识库：共 ${docs.length} 个会话。你是用户的知识神经中枢，需要跨会话回答。`];

  if (activeDoc) {
    lines.push('', `【当前会话】${activeDoc.title}`);
    if (activeDoc.subtitle) {
      lines.push(`主题：${activeDoc.subtitle}`);
    }
    if (activeDoc.summary) {
      lines.push(`摘要：${activeDoc.summary}`);
    }
    lines.push('要点：');
    for (const node of activeDoc.nodes) {
      const quote = node.quote.replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_CHARS);
      lines.push(`- ${node.title}${quote ? `：${quote}` : ''}`);
      if (lines.join('\n').length > MAX_CONTEXT_CHARS - 2600) {
        break;
      }
    }
    const room = MAX_CONTEXT_CHARS - lines.join('\n').length - 1600;
    if (room > 400) {
      lines.push(
        '原文节选：',
        activeDoc.text.replace(/\s+/g, ' ').trim().slice(0, Math.min(1200, room)),
      );
    }
  }

  const others = docs.filter((doc) => doc.id !== activeDoc?.id);
  if (others.length > 0) {
    lines.push('', '【其他会话】');
    for (const doc of others.slice(0, 12)) {
      const summary = doc.summary ? `：${clipPlain(doc.summary, 110)}` : '';
      lines.push(`- 《${doc.title}》${doc.subtitle ? `（${doc.subtitle}）` : ''}${summary}`);
      const keys = doc.nodes
        .slice(0, 3)
        .map((node) => node.title)
        .join('、');
      if (keys) {
        lines.push(`  关键点：${keys}`);
      }
      if (lines.join('\n').length > MAX_CONTEXT_CHARS - 400) {
        break;
      }
    }
  }

  return lines.join('\n').slice(0, MAX_CONTEXT_CHARS);
}

function clipPlain(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 给一句话里的重点加粗：优先加粗第一个分句，英文则取前几个词 */
function emphasizeQuote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || clean.includes('**')) {
    return clean;
  }
  const boundary = clean.search(/[，,：:；;]/);
  if (boundary >= 6 && boundary <= 48) {
    return `**${clean.slice(0, boundary)}**${clean.slice(boundary)}`;
  }
  if (/[\u4e00-\u9fa5]/.test(clean)) {
    return clean.length <= 32 ? `**${clean}**` : `**${clean.slice(0, 22)}**${clean.slice(22)}`;
  }
  const words = clean.split(' ');
  if (words.length <= 7) {
    return `**${clean}**`;
  }
  return `**${words.slice(0, 6).join(' ')}** ${words.slice(6).join(' ')}`;
}

/** 把例句里的目标单词加粗 */
function boldWord(sentence: string, word: string): string {
  const re = new RegExp(`\\b(${escapeRegExp(word)})\\b`, 'i');
  return re.test(sentence) ? sentence.replace(re, '**$1**') : sentence;
}

function requestBody(
  messages: OutgoingChatMessage[],
  context: string,
  config?: ApiConfig | null,
) {
  return JSON.stringify({
    messages,
    context,
    ...(config
      ? {
          config: {
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
          },
        }
      : {}),
  });
}

function requestHeaders(): Record<string, string> {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** 调用本地后端的多轮问答接口；传入用户自带配置时优先生效。 */
export async function requestAssistantReply(
  messages: OutgoingChatMessage[],
  context: string,
  config?: ApiConfig | null,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(resolveApiUrl('/api/ai/chat'), {
      method: 'POST',
      headers: requestHeaders(),
      body: requestBody(messages, context, config),
    });
  } catch {
    throw new Error('连接不到本地后端，请确认 npm run dev:server 已启动。');
  }

  let data: { reply?: unknown; error?: unknown } = {};
  try {
    data = (await response.json()) as typeof data;
  } catch {
    data = {};
  }
  if (!response.ok) {
    const detail = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (typeof data.reply !== 'string' || !data.reply.trim()) {
    throw new Error('模型返回为空，请稍后再试。');
  }
  return data.reply.trim();
}

/** 流式问答：逐段回调增量文本，返回完整回复。 */
export async function requestAssistantReplyStream(
  messages: OutgoingChatMessage[],
  context: string,
  config: ApiConfig | null | undefined,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(resolveApiUrl('/api/ai/chat/stream'), {
      method: 'POST',
      headers: requestHeaders(),
      body: requestBody(messages, context, config),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new Error('连接不到本地后端，请确认 npm run dev:server 已启动。');
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const data = (await response.json()) as { error?: unknown };
      if (typeof data.error === 'string') {
        detail = data.error;
      }
    } catch {
      // 忽略非 JSON 错误体
    }
    throw new Error(detail);
  }
  if (!response.body) {
    throw new Error('浏览器不支持流式响应。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let serverError: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (!payload) {
          continue;
        }
        try {
          const data = JSON.parse(payload) as { delta?: unknown; error?: unknown };
          if (typeof data.delta === 'string' && data.delta) {
            full += data.delta;
            onDelta(data.delta);
          } else if (typeof data.error === 'string') {
            serverError = data.error;
          }
        } catch {
          // 忽略非 JSON 事件
        }
      }
    }
  }

  if (serverError) {
    throw new Error(serverError);
  }
  if (!full.trim()) {
    throw new Error('模型返回为空，请稍后再试。');
  }
  return full.trim();
}

function clip(text: string, max = 110): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * 没有可用模型时的本地兜底：用已整理出的要点直接完成总结、出题与复习安排。
 * 命中不了意图时返回 null，交给上层提示配置 API。
 */
export function buildLocalAssistantReply(
  doc: KnowledgeDoc | null,
  prompt: string,
  docs: KnowledgeDoc[] = [],
): string | null {
  const nodes = doc?.nodes ?? [];
  const wantsQuiz = /出题|题目|自测|测验|测一测|quiz|questions?|test/i.test(prompt);
  // 闪卡 / 诊断 / 考前突击有专用流程，不再落到普通复习计划
  const wantsSkill = /闪卡|卡片|anki|诊断|为什么没懂|薄弱|补缺|考前|突击|备考|期末|冲刺|考试/i.test(
    prompt,
  );
  const wantsPlan =
    !wantsSkill && /复习|计划|安排|掌握|个性化|学习顺序|plan|review/i.test(prompt);
  const wantsSummary = /总结|摘要|概括|要点|梳理|summary/i.test(prompt);

  if (doc && nodes.length > 0 && wantsQuiz) {
    const picked = nodes.filter((node) => node.quote).slice(0, 5);
    if (picked.length === 0) {
      return null;
    }
    return [
      `本地出题 · 未调用模型（《${doc.title}》共 ${nodes.length} 个要点）`,
      '',
      ...picked.map(
        (node, index) =>
          `${index + 1}. ${node.question}\n   参考答案：${clip(node.quote, 90)}`,
      ),
      '',
      '想要选择题版本，可以在知识网络里点「题库」。',
    ].join('\n');
  }

  if (doc && nodes.length > 0 && wantsPlan) {
    const now = Date.now();
    const due = nodes.filter((node) => isDue(node.nextReviewAt, now));
    const weak = nodes.filter((node) => node.mastery === 0);
    return [
      `本地学习计划 · 未调用模型（《${doc.title}》）`,
      '',
      `共 ${nodes.length} 个要点，今天到期 ${due.length} 个，已掌握 ${
        nodes.filter((node) => node.mastery === 2).length
      } 个。`,
      due.length > 0
        ? `先复习到期节点：${due.slice(0, 6).map((node) => node.title).join('、')}`
        : '今天没有到期节点，可以开始新一轮自测巩固。',
      weak.length > 0
        ? `重点补强：${weak.slice(0, 6).map((node) => node.title).join('、')}`
        : '',
      '建议顺序：到期 → 模糊 → 已掌握，每轮 5 个，答错的下次优先。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (doc && nodes.length > 0 && wantsSummary) {
    const top = nodes.slice(0, 5);
    return [
      '本地总结 · 未调用模型',
      `主题：${doc.subtitle || doc.title}`,
      doc.summary ? `摘要：${doc.summary}` : '',
      top.length > 0
        ? `关键要点：\n${top.map((node, index) => `${index + 1}. **${node.title}**`).join('\n')}`
        : '',
      '想深入某一点，可以继续问我。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const library = docs.length > 0 ? docs : doc ? [doc] : [];

  // 学习技能：闪卡 / 诊断 / 考前突击（都基于已整理的要点，本地生成）
  if (doc && /闪卡|卡片|anki|flashcard/i.test(prompt)) {
    const cards = nodes.filter((node) => node.quote).slice(0, 10);
    return [
      `闪卡 · 未调用模型（《${doc.title}》共 ${cards.length} 张）`,
      '',
      ...cards.map(
        (node, index) =>
          `卡片 ${index + 1}\n正面：${node.question}\n背面：${clip(node.quote, 120)}`,
      ),
      '',
      '可以按「正面 → 背面」的顺序做主动回忆，也可以复制到 Anki / Obsidian。',
    ].join('\n');
  }

  if (doc && /诊断|为什么没懂|没掌握|薄弱|补缺|错题/.test(prompt)) {
    const weak = nodes.filter((node) => node.mastery === 0);
    const fuzzy = nodes.filter((node) => node.mastery === 1);
    const focus = [...weak, ...fuzzy].slice(0, 4);
    return [
      `学习诊断 · 未调用模型（《${doc.title}》）`,
      `还没记住 ${weak.length} 个，有点模糊 ${fuzzy.length} 个，今天到期 ${
        nodes.filter((node) => isDue(node.nextReviewAt, Date.now())).length
      } 个。`,
      '',
      focus.length > 0
        ? '优先补这几个缺口：'
        : '目前没有明显缺口，可以做一轮混合自测巩固。',
      ...focus.map(
        (node, index) =>
          `${index + 1}. **${node.title}**\n   ${emphasizeQuote(clip(node.quote, 120))}\n   自测：${node.question}`,
      ),
      '',
      '方法：先看讲解 → 合上原文自己复述 → 卡住就回到原文定位。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (doc && /考前|突击|备考|期末|冲刺|考试/.test(prompt)) {
    const due = nodes.filter((node) => isDue(node.nextReviewAt, Date.now()));
    const risk = [...due, ...nodes.filter((node) => node.mastery < 2)].slice(0, 5);
    return [
      `考前突击 · 未调用模型（《${doc.title}》）`,
      `高风险知识点 ${risk.length} 个，今天到期 ${due.length} 个。`,
      '',
      '三轮安排：',
      '1. 10 分钟：通读下面 5 个讲解，只记关键词；',
      '2. 15 分钟：合上原文做自测，答不出的标红；',
      '3. 5 分钟：只看标红条目，回到原文定位出处。',
      '',
      ...risk.map(
        (node, index) =>
          `${index + 1}. **${node.title}**\n   ${emphasizeQuote(clip(node.quote, 120))}\n   自测：${node.question}`,
      ),
      '',
      '需要闪卡或错题版，直接说「生成闪卡」「诊断薄弱点」。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (/所有会话|全部会话|知识库|全局|总览|哪些材料|神经中枢/.test(prompt)) {
    return [
      `本地总览 · 未调用模型（已接入 ${library.length} 个会话）`,
      ...library
        .slice(0, 8)
        .map(
          (item, index) =>
            `${index + 1}. 《${item.title}》${item.nodes.length} 个要点${
              item.subtitle ? ` · ${item.subtitle}` : ''
            }`,
        ),
      '可以继续问我任意会话里的概念。',
    ].join('\n');
  }

  const hits = searchKnowledge(library, prompt);
  if (hits.length > 0) {
    return [
      '本地检索 · 未调用模型（跨全部会话）',
      `命中 ${hits.length} 条相关要点：`,
      ...hits.map(
        (hit, index) =>
          `${index + 1}. 《${hit.docTitle}》${hit.nodeTitle}\n   ${clip(hit.quote, 120)}`,
      ),
      '配置模型后可以继续追问更完整的解释。',
    ].join('\n');
  }

  return null;
}

interface KnowledgeHit {
  docTitle: string;
  nodeTitle: string;
  quote: string;
  score: number;
}

function queryTerms(query: string): string[] {
  const latin = query.toLowerCase().match(/[a-z][a-z0-9-]{1,}/g) ?? [];
  const cjkRuns = query.replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/);
  const bigrams: string[] = [];
  for (const run of cjkRuns) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      bigrams.push(run.slice(index, index + 2));
    }
  }
  return [...new Set([...latin, ...bigrams])];
}

/** 跨会话的关键词检索：给本地兜底和神经中枢定位相关要点 */
export function searchKnowledge(
  docs: KnowledgeDoc[],
  query: string,
  limit = 5,
): KnowledgeHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const hits: KnowledgeHit[] = [];
  for (const doc of docs) {
    const title = `${doc.title} ${doc.subtitle ?? ''}`.toLowerCase();
    const titleHit = terms.some((term) => title.includes(term));
    for (const node of doc.nodes) {
      const haystack = `${node.title} ${node.quote}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += term.length >= 2 ? 1 : 0.5;
        }
      }
      if (titleHit) {
        score += 0.6;
      }
      if (score > 0) {
        hits.push({
          docTitle: doc.title,
          nodeTitle: node.title,
          quote: node.quote,
          score,
        });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

interface VocabEntry {
  word: string;
  phonetic: string;
  pos: string;
  meaning: string;
}

const VOCAB_ENTRY =
  /^([A-Za-z][A-Za-z'\- ]{0,28}?)\s*(?:\/([^/\n]{1,40})\/)?\s*(v|n|adj|adv|prep|conj|pron|phr)\.\s*(.{1,80})$/i;

/** 从笔记里识别单词条目（word /音标/ 词性. 释义），用于把例句升级成真正的讲解 */
function parseVocab(text: string): Map<string, VocabEntry> {
  const entries = new Map<string, VocabEntry>();
  for (const raw of text.split('\n').slice(0, 400)) {
    const line = raw.trim();
    if (!line || line.length > 120) {
      continue;
    }
    const match = line.match(VOCAB_ENTRY);
    if (!match) {
      continue;
    }
    const word = match[1].trim().toLowerCase();
    if (!word || word.split(/\s+/).length > 3) {
      continue;
    }
    entries.set(word, {
      word,
      phonetic: match[2] ? `/${match[2]}/` : '',
      pos: match[3],
      meaning: match[4].trim(),
    });
  }
  return entries;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[rows - 1][cols - 1];
}

function findVocabEntry(node: KnowledgeDoc['nodes'][number], entries: Map<string, VocabEntry>) {
  const haystack = `${node.title} ${node.quote}`.toLowerCase();
  let best: VocabEntry | null = null;
  for (const entry of entries.values()) {
    if (new RegExp(`\\b${escapeRegExp(entry.word)}\\b`).test(haystack)) {
      if (!best || entry.word.length > best.word.length) {
        best = entry;
      }
    }
  }
  if (best) {
    return best;
  }
  // 标题里的单词可能拼错（如 ascibe / ascribe），用编辑距离兜底
  const tokens = node.title.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  let closest: { entry: VocabEntry; distance: number } | null = null;
  for (const token of tokens) {
    for (const entry of entries.values()) {
      if (entry.word.includes(' ') || Math.abs(entry.word.length - token.length) > 2) {
        continue;
      }
      const distance = editDistance(token, entry.word);
      if (distance <= 2 && (!closest || distance < closest.distance)) {
        closest = { entry, distance };
      }
    }
  }
  return closest?.entry ?? null;
}

/** 抽取单个 doc 的学习画像：到期、薄弱、已掌握 */
function profileDoc(doc: KnowledgeDoc, now: number) {
  const due = doc.nodes.filter((node) => isDue(node.nextReviewAt, now));
  const weak = doc.nodes.filter((node) => node.mastery === 0);
  const fuzzy = doc.nodes.filter((node) => node.mastery === 1);
  const mastered = doc.nodes.filter((node) => node.mastery === 2);
  return { due, weak, fuzzy, mastered };
}

/** 给单个 doc 生成「薄弱诊断 + 复习安排」段落 */
function renderLearningPlan(doc: KnowledgeDoc, now: number): string[] {
  const { due, weak, fuzzy, mastered } = profileDoc(doc, now);
  const risk = [...due, ...weak, ...fuzzy];
  const lines = [
    '',
    `📊 学习诊断 · 《${doc.title}》`,
    `到期 ${due.length} · 薄弱 ${weak.length} · 模糊 ${fuzzy.length} · 已掌握 ${mastered.length}`,
  ];
  if (risk.length === 0) {
    lines.push('当前没有明显缺口，可以开始一轮混合自测巩固。');
  } else {
    lines.push(
      '建议顺序：到期 → 薄弱 → 模糊，每轮 5 个，答错的下次优先：',
      ...risk
        .slice(0, 5)
        .map((node, index) => `${index + 1}. **${node.title}**（${masteryLabel(node.mastery, node.nextReviewAt, now)}）`),
    );
  }
  return lines;
}

function masteryLabel(mastery: number, nextReviewAt: number | null, now: number): string {
  const tags: string[] = [];
  if (nextReviewAt && isDue(nextReviewAt, now)) {
    tags.push('今天到期');
  }
  tags.push(mastery === 0 ? '薄弱' : mastery === 1 ? '模糊' : '已掌握');
  return tags.join(' · ');
}

/** 自动出题：从 doc 的节点里挑有 quote 的若干条 */
function renderQuiz(doc: KnowledgeDoc, count = 5): string[] {
  const picked = doc.nodes.filter((node) => node.quote).slice(0, count);
  if (picked.length === 0) {
    return [];
  }
  return [
    '',
    `📝 自测 ${picked.length} 题（答案在题后）：`,
    ...picked.map(
      (node, index) => `${index + 1}. ${node.question}\n   答案：${clip(node.quote, 90)}`,
    ),
  ];
}

/**
 * 只针对当前知识库的自动开场：总览 → 知识点 → 学习诊断 → 出题。
 * 用于图谱页头部的「AI 助手」按钮，打开即开始个性化学习。
 */
export function buildAutoStudyBrief(doc: KnowledgeDoc | null): string | null {
  if (!doc || doc.nodes.length === 0) {
    return null;
  }
  const now = Date.now();
  const { due, weak, fuzzy, mastered } = profileDoc(doc, now);
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const vocab = parseVocab(doc.text);
  const childrenOf = new Map<string, string[]>();
  for (const node of doc.nodes) {
    if (!node.parentId) {
      continue;
    }
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(node.title);
    childrenOf.set(node.parentId, list);
  }

  const overview = [
    `📚 当前知识库《${doc.title}》`,
    doc.subtitle ? `主题：${doc.subtitle}` : '',
    doc.summary ? `摘要：${doc.summary}` : '',
    `规模：${doc.nodes.length} 个要点 · 今天到期 ${due.length} · 薄弱 ${weak.length} · 模糊 ${fuzzy.length} · 已掌握 ${mastered.length}`,
  ].filter(Boolean);

  const knowledgePoints = [
    '',
    `📍 知识点速览（共 ${doc.nodes.length} 个）：`,
    ...doc.nodes.flatMap((node, index) => {
      const lines = [`${index + 1}. **${node.title}**`];
      const entry = vocab.size > 0 ? findVocabEntry(node, vocab) : null;
      if (entry) {
        lines.push(
          `   **${entry.word}** ${entry.phonetic} ${entry.pos}. **${entry.meaning}**`
            .replace(/\s+/g, ' ')
            .trim(),
        );
        if (node.quote && !node.quote.includes(entry.meaning)) {
          lines.push(`   例：${boldWord(clip(node.quote, 160), entry.word)}`);
        }
      } else if (node.quote) {
        lines.push(`   ${emphasizeQuote(clip(node.quote, 240))}`);
      } else if (node.explanation) {
        // quote 缺失时，用本地合成的 explanation 作为讲解
        const body = node.explanation.replace(/^\*\*[^*]+\*\* 的要点：\n?/, '').trim();
        if (body) lines.push(`   ${clip(body, 240)}`);
      }
      const parent = node.parentId ? byId.get(node.parentId) : null;
      const children = childrenOf.get(node.id) ?? [];
      const structure = [
        parent ? `属于「${parent.title}」` : '',
        children.length > 0 ? `包含「${children.slice(0, 4).join('、')}」` : '',
      ].filter(Boolean);
      if (structure.length > 0) {
        lines.push(`   ${structure.join('，')}`);
      }
      return lines;
    }),
  ];

  return [
    ...overview,
    ...knowledgePoints,
    ...renderLearningPlan(doc, now),
    ...renderQuiz(doc, 5),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 跨所有会话的 hub 模式自动开场：总览 → 各会话摘要 → 全局薄弱诊断 → 全局出题。
 * 用于侧栏「AI 助手」入口。
 */
export function buildHubStudyBrief(docs: KnowledgeDoc[]): string | null {
  const nonEmpty = docs.filter((doc) => doc.nodes.length > 0);
  if (nonEmpty.length === 0) {
    return null;
  }
  const now = Date.now();
  const allDue = nonEmpty.reduce((sum, doc) => sum + doc.nodes.filter((n) => isDue(n.nextReviewAt, now)).length, 0);
  const allWeak = nonEmpty.reduce((sum, doc) => sum + doc.nodes.filter((n) => n.mastery === 0).length, 0);
  const allNodes = nonEmpty.reduce((sum, doc) => sum + doc.nodes.length, 0);

  const overview = [
    `🧠 知识库总览 · 共 ${nonEmpty.length} 个会话，${allNodes} 个要点`,
    `今天到期 ${allDue} · 薄弱 ${allWeak} · 跨会话回答任一侧材料的问题。`,
  ];

  const summaries = [
    '',
    '📚 各会话摘要：',
    ...nonEmpty.slice(0, 6).map((doc, index) => {
      const { due, weak } = profileDoc(doc, now);
      const firstPoints = doc.nodes.slice(0, 3).map((n) => n.title).join('、');
      return `${index + 1}. **${doc.title}**${doc.subtitle ? `（${doc.subtitle}）` : ''} · ${doc.nodes.length} 要点${due.length > 0 ? ` · 到期 ${due.length}` : ''}${weak.length > 0 ? ` · 薄弱 ${weak.length}` : ''}${firstPoints ? `\n   要点：${firstPoints}` : ''}`;
    }),
  ];

  // 全局薄弱点：按 (due, weak, fuzzy) 排序挑前 5 个节点
  const rankedRisk = nonEmpty
    .flatMap((doc) => {
      return doc.nodes
        .filter((node) => isDue(node.nextReviewAt, now) || node.mastery < 2)
        .map((node) => ({ doc, node }));
    })
    .sort((a, b) => {
      const scoreOf = (item: { doc: KnowledgeDoc; node: KnowledgeDoc['nodes'][number] }) => {
        let s = 0;
        if (isDue(item.node.nextReviewAt, now)) s += 10;
        if (item.node.mastery === 0) s += 6;
        else if (item.node.mastery === 1) s += 3;
        return s;
      };
      return scoreOf(b) - scoreOf(a);
    })
    .slice(0, 5);

  const diagnosis = [
    '',
    '🎯 全局薄弱诊断（优先补缺）：',
    rankedRisk.length === 0
      ? '当前所有会话都没有明显缺口，可以挑一个做混合自测。'
      : rankedRisk.map((item, index) => {
          const { doc, node } = item;
          return `${index + 1}. **${node.title}**（来自《${doc.title}》）\n   ${emphasizeQuote(clip(node.quote || node.question, 120))}`;
        }),
  ];

  // 全局出题：从不同会话各挑 1 题
  const quiz: string[] = [];
  let idx = 0;
  for (const doc of nonEmpty) {
    const pick = doc.nodes.find((n) => n.quote);
    if (pick && idx < 5) {
      quiz.push(`${idx + 1}. ${pick.question}（来自《${doc.title}》）\n   答案：${clip(pick.quote, 90)}`);
      idx += 1;
    }
    if (idx >= 5) break;
  }

  const quizSection = quiz.length > 0 ? ['', '📝 跨会话自测（5 题）：', ...quiz] : [];

  return [...overview, ...summaries, ...diagnosis, ...quizSection].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}


