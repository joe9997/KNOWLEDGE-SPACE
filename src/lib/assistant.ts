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

  lines.push(
    '',
    '【回答方式】把原文当作依据而不是稿子：不要整段照抄，用自己的话先讲清结论，再解释关键概念、原因以及它们之间的关系，让读者真正理解而不是复述。',
  );

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

  // 神经中枢：只要提到全部/跨会话/全局，就用所有材料一起回答
  const library = docs.length > 0 ? docs : doc ? [doc] : [];
  const hubIntent = /所有会话|全部会话|所有材料|全部材料|跨会话|全局|知识库|神经中枢/.test(prompt);

  if (/逐个讲解|逐条讲解|一个个讲|详细讲解/.test(prompt)) {
    const walkthrough = hubIntent || library.length > 1
      ? buildHubWalkthrough(library)
      : buildDocWalkthrough(doc);
    if (walkthrough) return walkthrough;
  }

  if (hubIntent && (wantsSummary || wantsPlan || wantsSkill || wantsQuiz)) {
    const brief = buildHubStudyBrief(library);
    if (brief) return brief;
  }

  if (doc && nodes.length > 0 && wantsQuiz) {
    const picked = nodes
      .filter((node) => node.quote && node.quote.length > 30 && node.question)
      .sort((a, b) => (b.quote?.length ?? 0) - (a.quote?.length ?? 0))
      .slice(0, 5);
    if (picked.length === 0) {
      return null;
    }
    const lines: string[] = [
      `📝 自测 ${picked.length} 题 · 来自《${doc.title}》`,
      '先自己作答，再对照参考答案。每题都附思路提示和解析。',
    ];
    picked.forEach((node, index) => {
      lines.push('', `${index + 1}. ${node.question}`);
      lines.push(`   💭 思路：先回忆「${node.title}」的核心，再用自己的话组织答案`);
      lines.push(`   ✅ 参考答案：${buildNodeExplanation(node, 140)}`);
      if (node.quoteStart >= 0) {
        lines.push(`   📖 出处：《${doc.title}》原文第 ${node.quoteStart + 1} 字附近`);
      }
      const why = buildAnswerAnalysis(node);
      if (why) {
        lines.push(`   🔍 解析：${why}`);
      }
    });
    lines.push('', '想要选择题版本，可以在知识网络里点「题库」。');
    return lines.join('\n');
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
    // 只讲最值得记的几条规则：排除中心主题、空引用和套话标题
    const RULE_CUE =
      /(转换|精度|隐式|显式|必须|不能|规则|范围|赋值|区别|是指|指的是|定义为|分为|包括)/g;
    const genericTitle = /^(例|举例|注意|同样|因此|所以|概述|小结|总结|目录|更多)/;
    const candidates = nodes
      .map((node, index) => ({ node, index }))
      .filter(
        ({ node }) =>
          node.level > 0 &&
          node.quote.replace(/\s+/g, '').length >= 12 &&
          !genericTitle.test(node.title.trim()),
      )
      .map(({ node, index }) => ({
        node,
        index,
        score:
          (node.quote.match(RULE_CUE) ?? []).length * 3 +
          Math.min(4, node.quote.length / 50) +
          (node.level === 1 ? 2 : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const lines: string[] = [
      `📚 《${doc.title}》· 这章最值得记的 ${candidates.length} 条`,
      doc.subtitle ? `主题：${doc.subtitle}` : '',
    ].filter(Boolean);

    candidates.forEach(({ node }, index) => {
      const rule = pickKeySentence(node.quote, 100);
      lines.push('', `${index + 1}. **${node.title}**`);
      if (rule) {
        lines.push(`   ${rule}`);
      }
      const example = node.quote.match(/(?:例如|比如|例|如)[：:]\s*([^。！？；]{6,80})/);
      if (example) {
        lines.push(`   例：${example[1].trim()}`);
      }
    });

    const structure = nodes
      .filter((node) => node.level <= 1 && node.level > 0)
      .map((node) => node.title)
      .slice(0, 6);
    if (structure.length > 0) {
      lines.push('', `结构：${structure.join(' · ')}`);
    }
    lines.push('', '想针对某条规则练一下，说「出题考我」。');
    return lines.join('\n');
  }

  // 学习技能：闪卡 / 诊断 / 考前突击（都基于已整理的要点，本地生成）
  if (doc && /闪卡|卡片|anki|flashcard/i.test(prompt)) {
    const cards = nodes.filter((node) => node.quote).slice(0, 10);
    return [
      `闪卡 · 未调用模型（《${doc.title}》共 ${cards.length} 张）`,
      '',
      ...cards.map(
        (node, index) =>
          `卡片 ${index + 1}\n正面：${node.question}\n背面：${buildNodeExplanation(node, 120)}`,
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
          `${index + 1}. **${node.title}**\n   ${buildNodeExplanation(node, 120)}\n   自测：${node.question}`,
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
          `${index + 1}. **${node.title}**\n   ${buildNodeExplanation(node, 120)}\n   自测：${node.question}`,
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
          `${index + 1}. 《${hit.docTitle}》${hit.nodeTitle}\n   ${toExplanationTone(clip(hit.quote, 120))}`,
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

/** 抽取单个 doc 的学习画像：到期、薄弱、已掌握 */
function profileDoc(doc: KnowledgeDoc, now: number) {
  const due = doc.nodes.filter((node) => isDue(node.nextReviewAt, now));
  const weak = doc.nodes.filter((node) => node.mastery === 0);
  const fuzzy = doc.nodes.filter((node) => node.mastery === 1);
  const mastered = doc.nodes.filter((node) => node.mastery === 2);
  return { due, weak, fuzzy, mastered };
}

/** 从 quote 里抽出最有信息量的 1 句（优先含定义/因果/数字的句子） */
function pickKeySentence(quote: string, maxLen = 110): string {
  const clean = quote.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  // 按句子切分，给每句打分：含"是/因为/所以/称为/指/例如/即"的优先
  const sentences = clean.split(/(?<=[。！？；.!?;])/).filter((s) => s.trim().length > 8);
  if (sentences.length === 0) return `${clean.slice(0, maxLen)}…`;
  const scored = sentences.map((s) => {
    let score = 0;
    if (/是指|指的是|称为|叫作|定义为|是一种|是一个/.test(s)) score += 5;
    if (/因为|所以|因此|由于|导致/.test(s)) score += 4;
    if (/例如|比如|举例/.test(s)) score += 3;
    if (/\d+/.test(s)) score += 2;
    if (/首先|其次|最后|第一|第二|第三/.test(s)) score += 2;
    // 长度惩罚：太短没信息，太长不好读
    if (s.length < 20) score -= 1;
    if (s.length > 140) score -= 1;
    return { s: s.trim(), score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].s;
  return best.length > maxLen ? `${best.slice(0, maxLen)}…` : best;
}

type KnowledgeKind = 'definition' | 'causal' | 'process' | 'example' | 'data' | 'argument';

const KIND_HINT: Record<KnowledgeKind, string> = {
  definition: '理解定义后，试着举一个能套用它的例子，知识才算真正落地。',
  causal: '抓住"为什么会这样"这条因果链，比只记住结论更有用。',
  process: '按步骤顺序复述一遍，注意每一步依赖前一步的什么结果。',
  example: '先看这个例子在证明什么，再换一个自己的场景举出新例子。',
  data: '把数字和它对应的含义绑在一起记，单记数字很容易忘。',
  argument: '把它放回材料的整体论证里，想清楚它支撑的是哪个结论。',
};

function detectKnowledgeKind(node: KnowledgeDoc['nodes'][number]): KnowledgeKind {
  const text = `${node.title} ${node.quote}`;
  if (/是指|指的是|称为|叫作|定义为|是一种|是一个/.test(text)) return 'definition';
  if (/因为|所以|因此|由于|导致/.test(text)) return 'causal';
  if (/首先|其次|最后|第一|第二|步骤|阶段|流程/.test(text)) return 'process';
  if (/例如|比如|举例|譬如/.test(text)) return 'example';
  if (/\d+%|\d+倍|\d+个|\d+年|\d+次/.test(text)) return 'data';
  return 'argument';
}

/** 把原文句子改写成讲解口吻，避免整句照搬 */
function toExplanationTone(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(首先|其次|再次|最后|另外|此外|因此|所以|但是|然而|不过|而且|并且|同时)[，,]\s*/, '')
    .replace(/是指|指的是/g, '可以理解为')
    .replace(/称为|叫作|定义为/g, '被称为')
    .replace(/是一种|是一个/g, '本质上是一种')
    .replace(/由于/g, '因为')
    .trim();
}

/**
 * 生成便于理解的"参考答案"：优先用 AI 扩写，其次把关键句改写成讲解口吻，
 * 再补一句理解方向，避免把原文整句当成答案。
 */
export function buildNodeExplanation(
  node: KnowledgeDoc['nodes'][number],
  maxLen = 180,
): string {
  const expanded = node.explanation?.replace(/^\*\*[^*]+\*\* 的要点：\n?/, '').trim();
  if (expanded) {
    return clip(expanded, Math.max(maxLen, 220));
  }
  const key = node.quote ? pickKeySentence(node.quote, 110) : '';
  if (!key) {
    return `围绕「${node.title}」理解：先弄清它解决什么问题，再想它和相邻概念的关系。`;
  }
  return `${toExplanationTone(key)} ${KIND_HINT[detectKnowledgeKind(node)]}`;
}

/** 给节点生成一句"记忆钩子"：根据标题和引用内容选择不同的记忆策略 */
function buildMemoryHook(node: KnowledgeDoc['nodes'][number]): string {
  const title = node.title;
  const quote = node.quote || '';
  // 对比型
  if (/与|和|vs|区别|对比|比较/.test(title)) {
    return '💡 试着用自己的话说出两者的关键区别';
  }
  // 流程型
  if (/流程|步骤|过程|阶段|顺序/.test(title + quote)) {
    return '💡 在脑子里把这个流程走一遍，注意每一步的输入输出';
  }
  // 定义型
  if (/是指|指的是|称为|是一种|定义为/.test(quote)) {
    return '💡 合上书，用一句话向朋友解释这个概念';
  }
  // 数字/公式型
  if (/\d+%|\d+倍|\d+个|公式|方程/.test(quote)) {
    return '💡 记住关键数字，再想一个生活中的对应例子';
  }
  // 因果型
  if (/因为|所以|导致|因此|由于/.test(quote)) {
    return '💡 问自己：如果条件反过来，结果会怎样？';
  }
  // 默认
  return '💡 找一个生活/工作中的场景，把这个概念套进去';
}

/** 把 doc 的节点按顶层主题分组（用 parent 链向上找到 level 0 祖先） */
function groupByRootTheme(doc: KnowledgeDoc): Map<string, KnowledgeDoc['nodes']> {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const rootOf = (node: KnowledgeDoc['nodes'][number]): KnowledgeDoc['nodes'][number] => {
    let cur = node;
    let depth = 0;
    while (cur.parentId && depth < 6) {
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      cur = parent;
      depth += 1;
    }
    return cur;
  };
  const groups = new Map<string, KnowledgeDoc['nodes']>();
  for (const node of doc.nodes) {
    const root = rootOf(node);
    const key = root.id === node.id ? `__self__${node.id}` : root.title;
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }
  return groups;
}

interface VocabEntry {
  word: string;
  pos: string;
  meaning: string;
  example: string;
}

/** 识别「word /音标/ 词性 释义」格式的单词笔记，并抓取紧随其后的英文例句。 */
function parseVocabEntries(text: string): VocabEntry[] {
  const entries: VocabEntry[] = [];
  let current: VocabEntry | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(
      /^([A-Za-z][A-Za-z'-]*)\s+(?:\/[^/]+\/\s+)?((?:n|v|adj|adv|prep|conj|pron|num|int|phr)\.)\s*(.+)$/i,
    );
    if (match) {
      current = {
        word: match[1].toLowerCase(),
        pos: match[2],
        meaning: match[3].trim(),
        example: '',
      };
      entries.push(current);
      continue;
    }
    if (
      current &&
      !current.example &&
      /[A-Za-z]/.test(line) &&
      !/[\u4e00-\u9fa5]/.test(line) &&
      line.split(/\s+/).length >= 4
    ) {
      current.example = line;
    }
  }
  return entries;
}

function vocabDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = saved;
    }
  }
  return row[b.length];
}

function firstEnglishToken(text: string): string {
  return text.match(/[A-Za-z][A-Za-z'-]*/)?.[0].toLowerCase() ?? '';
}

/** 单词笔记在通用导览之外补充释义、原例句和节点标题中的拼写纠正。 */
function buildVocabStudyLines(doc: KnowledgeDoc): string[] {
  const entries = parseVocabEntries(doc.text);
  if (entries.length === 0) return [];
  const lines: string[] = ['', '单词精讲（释义 · 例句 · 拼写）'];
  for (const [index, entry] of entries.slice(0, 6).entries()) {
    lines.push(`${index + 1}. **${entry.word}** · ${entry.pos} ${entry.meaning}`);
    if (entry.example) {
      lines.push(`   例：${entry.example}`);
    }
    const matchedNode = doc.nodes.find((node) => {
      const token = firstEnglishToken(node.title);
      if (!token || token === entry.word || token[0] !== entry.word[0]) return false;
      return vocabDistance(token, entry.word) <= (entry.word.length >= 7 ? 2 : 1);
    });
    if (matchedNode) {
      const typo = firstEnglishToken(matchedNode.title);
      lines.push(`   拼写提醒：「${typo}」应写作「${entry.word}」。`);
    }
  }
  return lines;
}

/**
 * 只针对当前知识库的自动开场：总览 → 核心概念地图（按主题分组） → 学习路径 → 学习状态 → 高质量自测。
 * 重写后的版本更像一个真正的"AI 助教"在带你预习这份材料。
 */
export function buildAutoStudyBrief(doc: KnowledgeDoc | null): string | null {
  if (!doc || doc.nodes.length === 0) {
    return null;
  }
  const now = Date.now();
  const { due, weak, fuzzy, mastered } = profileDoc(doc, now);

  // ===== 1. 开场：一句话说清这份材料的价值 =====
  const opening = [
    `📚 《${doc.title}》· 学习导览`,
    doc.subtitle ? `这份材料围绕「${doc.subtitle}」展开，共 ${doc.nodes.length} 个核心概念。` : `共 ${doc.nodes.length} 个核心概念，我已为你梳理好结构。`,
  ];

  // ===== 2. 一句话概括（用 summary 或自动合成） =====
  const overview: string[] = [];
  if (doc.summary) {
    overview.push('', '🎯 这份材料在讲什么', doc.summary);
  } else {
    // 没有 summary 时，用前 3 个 level 0 节点标题拼一个导览
    const roots = doc.nodes.filter((n) => !n.parentId).slice(0, 3).map((n) => n.title);
    if (roots.length > 0) {
      overview.push('', '🎯 这份材料在讲什么', `主要覆盖 ${roots.join('、')} 等主题。建议先建立整体框架，再逐个深入。`);
    }
  }

  // ===== 3. 核心概念地图：按主题分组，每个概念给"核心 + 关键细节 + 记忆钩子" =====
  const groups = groupByRootTheme(doc);
  const conceptLines: string[] = ['', '📍 核心概念地图'];
  let conceptIndex = 0;
  const MAX_CONCEPTS = 8; // 最多展示 8 个，避免信息过载

  for (const [theme, nodes] of groups.entries()) {
    if (conceptIndex >= MAX_CONCEPTS) break;
    // 顶层主题（level 0 节点）作为分组标题
    const isSelfGroup = theme.startsWith('__self__');
    const themeName = isSelfGroup ? null : theme;
    if (themeName) {
      conceptLines.push('', `▸ ${themeName}`);
    }
    for (const node of nodes.slice(0, isSelfGroup ? 1 : 3)) {
      if (conceptIndex >= MAX_CONCEPTS) break;
      conceptIndex += 1;
      conceptLines.push(`${conceptIndex}. **${node.title}**`);
      // 关键细节：从 quote 里挑最有信息量的一句
      const key = node.quote ? pickKeySentence(node.quote, 100) : '';
      if (key) {
        conceptLines.push(`   ${emphasizeQuote(key)}`);
      } else if (node.explanation) {
        const body = node.explanation.replace(/^\*\*[^*]+\*\* 的要点：\n?/, '').trim();
        if (body) conceptLines.push(`   ${clip(body, 100)}`);
      }
      // 记忆钩子
      conceptLines.push(`   ${buildMemoryHook(node)}`);
    }
  }
  if (doc.nodes.length > MAX_CONCEPTS) {
    conceptLines.push('', `（还有 ${doc.nodes.length - MAX_CONCEPTS} 个概念，可以在图谱里逐个查看）`);
  }

  // ===== 4. 推荐学习路径：按 level 分层，先基础后进阶 =====
  const roots = doc.nodes.filter((n) => !n.parentId);
  const leaves = doc.nodes.filter((n) => n.parentId && !doc.nodes.some((m) => m.parentId === n.id));
  const pathLines: string[] = ['', '🧭 推荐学习路径'];
  if (roots.length > 0) {
    pathLines.push(`① 先建立框架：${roots.slice(0, 3).map((n) => `**${n.title}**`).join(' → ')}`);
  }
  if (leaves.length > 0 && leaves.length !== roots.length) {
    pathLines.push(`② 再深入细节：重点攻克 ${leaves.slice(0, 3).map((n) => `**${n.title}**`).join('、')}`);
  }
  if (weak.length > 0) {
    pathLines.push(`③ 最后补薄弱：${weak.slice(0, 2).map((n) => `**${n.title}**`).join('、')}（你之前标记为没记住）`);
  }
  pathLines.push('每学完一个，合上书自己复述一遍，卡壳就回到原文定位。');

  // ===== 5. 你的学习状态 =====
  const statusLines = [
    '',
    '📊 你的学习状态',
    `已掌握 ${mastered.length} · 模糊 ${fuzzy.length} · 薄弱 ${weak.length} · 今天到期 ${due.length}`,
  ];
  if (due.length > 0) {
    statusLines.push(`⚡ 优先复习：${due.slice(0, 3).map((n) => `**${n.title}**`).join('、')}`);
  } else if (weak.length > 0) {
    statusLines.push(`⚡ 优先补缺：${weak.slice(0, 3).map((n) => `**${n.title}**`).join('、')}`);
  } else if (mastered.length === doc.nodes.length) {
    statusLines.push('🎉 全部掌握！可以做一轮混合自测巩固。');
  }

  // ===== 6. 高质量自测：题目 + 思路提示 + 结构化答案 =====
  const quizLines = renderQuizV2(doc, 3);

  return [
    ...opening,
    ...overview,
    ...buildVocabStudyLines(doc),
    ...conceptLines,
    ...pathLines,
    ...statusLines,
    ...quizLines,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 高质量自测：题目 + 思路提示 + 结构化答案（核心要点 + 原文出处 + 解析） */
function renderQuizV2(doc: KnowledgeDoc, count = 3): string[] {
  // 优先选有 quote、有 question、内容充实的节点
  const candidates = doc.nodes
    .filter((n) => n.quote && n.quote.length > 30 && n.question)
    .sort((a, b) => (b.quote?.length ?? 0) - (a.quote?.length ?? 0));
  const picked = candidates.slice(0, count);
  if (picked.length === 0) return [];

  const lines: string[] = ['', `📝 自测 ${picked.length} 题（先自己答，再看答案）`];
  picked.forEach((node, index) => {
    lines.push('', `${index + 1}. ${node.question}`);
    // 思路提示：给思考方向但不剧透答案
    lines.push(`   💭 思路：先回忆「${node.title}」的核心，再用自己的话讲出来`);
    // 讲解型答案：改写成自己的话，不照搬原文
    lines.push(`   ✅ 参考答案：${buildNodeExplanation(node, 160)}`);
    if (node.quoteStart >= 0) {
      lines.push(`   📖 出处：《${doc.title}》原文第 ${node.quoteStart + 1} 字附近`);
    }
    // 解析：为什么这是答案
    const why = buildAnswerAnalysis(node);
    if (why) {
      lines.push(`   🔍 解析：${why}`);
    }
  });
  return lines;
}

/** 生成答案解析：解释"为什么这样理解"，帮助把知识点串起来 */
export function buildAnswerAnalysis(node: KnowledgeDoc['nodes'][number]): string {
  switch (detectKnowledgeKind(node)) {
    case 'definition':
      return '这是定义型知识点：先用自己的话讲清它是什么，再补一个例子，比背原句更牢固。';
    case 'causal':
      return '这是因果型知识点：重点理解"为什么会这样"，把原因和结果连成一条链。';
    case 'example':
      return '这是举例型知识点：先看例子在证明什么，再自己举一个新例子验证理解。';
    case 'process':
      return '这是流程型知识点：注意步骤之间的先后顺序和依赖关系，按流程走一遍。';
    case 'data':
      return '这是数据型知识点：记住关键数字，并说清它对应的含义和适用场景。';
    default:
      return '这是材料的核心论点之一：把它放回整体框架里，想清楚它支撑什么结论、和哪些概念相关。';
  }
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
          return `${index + 1}. **${node.title}**（来自《${doc.title}》）\n   ${buildNodeExplanation(node, 140)}`;
        }),
  ];

  // 全局出题：从不同会话各挑 1 题，用高质量结构化答案
  const quiz: string[] = [];
  let idx = 0;
  for (const doc of nonEmpty) {
    const pick = doc.nodes
      .filter((n) => n.quote && n.quote.length > 30 && n.question)
      .sort((a, b) => (b.quote?.length ?? 0) - (a.quote?.length ?? 0))[0];
    if (pick && idx < 5) {
      quiz.push(`${idx + 1}. ${pick.question}（来自《${doc.title}》）`);
      quiz.push(`   💭 思路：先回忆「${pick.title}」的核心，再用自己的话讲出来`);
      quiz.push(`   ✅ 参考答案：${buildNodeExplanation(pick, 160)}`);
      const why = buildAnswerAnalysis(pick);
      if (why) {
        quiz.push(`   🔍 解析：${why}`);
      }
      idx += 1;
    }
    if (idx >= 5) break;
  }

  const quizSection = quiz.length > 0 ? ['', '📝 跨会话自测（先自己答，再看答案）：', ...quiz] : [];

  return [...overview, ...summaries, ...diagnosis, ...quizSection].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 针对单份材料的逐个讲解：用自己的话解释每个知识点，而不是复述原文 */
function buildDocWalkthrough(doc: KnowledgeDoc | null): string | null {
  const nodes = (doc?.nodes ?? []).filter((node) => node.quote).slice(0, 6);
  if (!doc || nodes.length === 0) {
    return null;
  }
  const lines = [
    `🧭 逐个讲解 · 《${doc.title}》共 ${nodes.length} 个知识点`,
    '下面是理解版讲解：原文只作依据，我用自己的话帮你把概念讲清楚。',
  ];
  nodes.forEach((node, index) => {
    lines.push('', `${index + 1}. **${node.title}**`);
    lines.push(`   ${buildNodeExplanation(node, 150)}`);
    lines.push(`   💡 ${buildMemoryHook(node)}`);
  });
  return lines.join('\n');
}

/** 跨会话逐个讲解：每个会话挑几个关键知识点，用自己的话讲清楚 */
function buildHubWalkthrough(docs: KnowledgeDoc[]): string | null {
  const nonEmpty = docs.filter((doc) => doc.nodes.some((node) => node.quote));
  if (nonEmpty.length === 0) {
    return null;
  }
  const perDoc = Math.max(1, Math.min(3, Math.ceil(8 / nonEmpty.length)));
  const picks: Array<{ doc: KnowledgeDoc; node: KnowledgeDoc['nodes'][number] }> = [];
  for (const doc of nonEmpty) {
    doc.nodes
      .filter((node) => node.quote)
      .slice(0, perDoc)
      .forEach((node) => picks.push({ doc, node }));
  }
  if (picks.length === 0) {
    return null;
  }
  const lines = [
    `🧭 逐个讲解 · 跨 ${nonEmpty.length} 个会话，共 ${picks.length} 个关键知识点`,
    '下面是理解版讲解：原文只作依据，我用自己的话帮你把概念讲清楚。',
  ];
  picks.slice(0, 8).forEach(({ doc, node }, index) => {
    lines.push('', `${index + 1}. **${node.title}**（来自《${doc.title}》）`);
    lines.push(`   ${buildNodeExplanation(node, 150)}`);
  });
  return lines.join('\n');
}



