import { findQuote } from '../lib/quotes';
import { DAY_MS } from '../lib/review';
import type { KnowledgeDoc, KnowledgeNode, Mastery, Relation } from '../lib/types';

export const DEMO_DOC_ID = 'demo-proof-burden';

export const DEMO_NOTICE = '体验材料 · 仅用于演示产品流程，不构成法律意见';

export const DEMO_TEXT = `# 证据法讲义 · 证明责任

证明责任是民事证据制度的核心问题，它要回答在事实真伪不明时由谁承担不利后果。证明责任包括主观证明责任与客观证明责任两个层面，二者共同构成裁判的事实基础。

证明对象是当事人需要运用证据加以证明的事实范围。当事人提出权利主张时，必须首先明确需要证明的要件事实，法院围绕这些事实组织审理。

主张责任要求当事人对自己提出的有利于己的事实承担提出责任。未能提出具体主张的一方，通常也无法获得相应的证据调查机会。

证明责任的分配遵循规范说，即由主张权利存在的一方对权利发生的事实承担证明责任。这一分配规则把败诉风险固定在主张者一侧。

本证是负有证明责任的一方为证明其主张成立而提出的证据。反证则是不负证明责任的一方为动摇法官心证而提出的证据。

举证时限是法院指定或当事人协商确定的提交证据期间。超过举证时限提交的证据，可能面临不予采纳的后果。

证明标准是法官认定事实所需达到的证明程度。民事案件通常适用高度盖然性标准，特殊事项则可能适用更严格的证明标准。

证据能力是证据材料进入法庭调查的资格。不具备真实性、合法性与关联性的材料，不能作为认定案件事实的根据。

自由心证要求法官依据法庭调查中的全部证据，运用逻辑与经验独立判断证明力。自由心证并非任意裁判，仍须说明裁判理由。

推定是依据已知事实推断未知事实的规则。法律上的推定可以转移证明责任，事实上的推定则更多影响证明力的评价。

证明妨碍是指一方以不正当手段使对方无法举证的情形。发生证明妨碍时，法院可以减轻对方当事人的证明负担。

经验法则是一般人从生活经验中归纳出的共同认识。经验法则可以帮助法官评价证据，但不能代替对具体事实的证明。`;

interface DemoNodeSeed {
  id: string;
  title: string;
  quote: string;
  question: string;
  parentId: string | null;
  level: number;
  mastery: Mastery;
  goodStreak: number;
  /** 相对当前时间的天数，负数表示已到期 */
  dueOffsetDays: number;
  reviewedOffsetDays: number | null;
}

const DEMO_NODE_SEEDS: DemoNodeSeed[] = [
  {
    id: 'n-core',
    title: '证明责任',
    quote: '证明责任是民事证据制度的核心问题，它要回答在事实真伪不明时由谁承担不利后果。',
    question: '事实真伪不明时，由谁承担不利后果？',
    parentId: null,
    level: 0,
    mastery: 2,
    goodStreak: 2,
    dueOffsetDays: 8,
    reviewedOffsetDays: 2,
  },
  {
    id: 'n-proof-object',
    title: '证明对象',
    quote: '证明对象是当事人需要运用证据加以证明的事实范围。',
    question: '哪些事实属于证明对象？',
    parentId: 'n-core',
    level: 1,
    mastery: 2,
    goodStreak: 1,
    dueOffsetDays: 7,
    reviewedOffsetDays: 3,
  },
  {
    id: 'n-claim-burden',
    title: '主张责任',
    quote: '主张责任要求当事人对自己提出的有利于己的事实承担提出责任。',
    question: '谁需要先提出有利于自己的事实？',
    parentId: 'n-core',
    level: 1,
    mastery: 1,
    goodStreak: 0,
    dueOffsetDays: 1.2,
    reviewedOffsetDays: 1,
  },
  {
    id: 'n-distribution',
    title: '证明责任分配',
    quote: '证明责任的分配遵循规范说，即由主张权利存在的一方对权利发生的事实承担证明责任。',
    question: '规范说把证明责任分配给了哪一方？',
    parentId: 'n-core',
    level: 1,
    mastery: 2,
    goodStreak: 2,
    dueOffsetDays: 9,
    reviewedOffsetDays: 4,
  },
  {
    id: 'n-principal-evidence',
    title: '本证',
    quote: '本证是负有证明责任的一方为证明其主张成立而提出的证据。',
    question: '本证由哪一方提出？',
    parentId: 'n-distribution',
    level: 2,
    mastery: 2,
    goodStreak: 1,
    dueOffsetDays: 10,
    reviewedOffsetDays: 5,
  },
  {
    id: 'n-counter-evidence',
    title: '反证',
    quote: '反证则是不负证明责任的一方为动摇法官心证而提出的证据。',
    question: '反证的目的和提出主体是什么？',
    parentId: 'n-distribution',
    level: 2,
    mastery: 1,
    goodStreak: 0,
    dueOffsetDays: 8,
    reviewedOffsetDays: 6,
  },
  {
    id: 'n-evidence-deadline',
    title: '举证时限',
    quote: '举证时限是法院指定或当事人协商确定的提交证据期间。',
    question: '超期提交证据可能有什么后果？',
    parentId: 'n-core',
    level: 1,
    mastery: 1,
    goodStreak: 0,
    dueOffsetDays: 2.4,
    reviewedOffsetDays: 1,
  },
  {
    id: 'n-standard',
    title: '证明标准',
    quote: '证明标准是法官认定事实所需达到的证明程度。',
    question: '民事案件通常适用什么证明标准？',
    parentId: 'n-core',
    level: 1,
    mastery: 2,
    goodStreak: 1,
    dueOffsetDays: 6,
    reviewedOffsetDays: 2,
  },
  {
    id: 'n-competence',
    title: '证据能力',
    quote: '证据能力是证据材料进入法庭调查的资格。',
    question: '证据材料进入法庭调查需要具备什么？',
    parentId: 'n-core',
    level: 1,
    mastery: 1,
    goodStreak: 0,
    dueOffsetDays: 1.5,
    reviewedOffsetDays: 0.5,
  },
  {
    id: 'n-free-evaluation',
    title: '自由心证',
    quote: '自由心证要求法官依据法庭调查中的全部证据，运用逻辑与经验独立判断证明力。',
    question: '自由心证是否意味着法官可以任意裁判？',
    parentId: 'n-core',
    level: 1,
    mastery: 0,
    goodStreak: 0,
    dueOffsetDays: -1,
    reviewedOffsetDays: 2,
  },
  {
    id: 'n-presumption',
    title: '推定',
    quote: '推定是依据已知事实推断未知事实的规则。',
    question: '推定如何影响证明责任？',
    parentId: 'n-core',
    level: 1,
    mastery: 0,
    goodStreak: 0,
    dueOffsetDays: -2,
    reviewedOffsetDays: 3,
  },
  {
    id: 'n-obstruction',
    title: '证明妨碍',
    quote: '证明妨碍是指一方以不正当手段使对方无法举证的情形。',
    question: '一方妨碍对方举证会产生什么后果？',
    parentId: 'n-core',
    level: 1,
    mastery: 1,
    goodStreak: 0,
    dueOffsetDays: -0.2,
    reviewedOffsetDays: 1,
  },
  {
    id: 'n-experience',
    title: '经验法则',
    quote: '经验法则是一般人从生活经验中归纳出的共同认识。',
    question: '经验法则能代替对具体事实的证明吗？',
    parentId: 'n-core',
    level: 1,
    mastery: 2,
    goodStreak: 1,
    dueOffsetDays: 12,
    reviewedOffsetDays: 3,
  },
];

const DEMO_RELATION_SEEDS: Array<[string, string]> = [
  ['n-presumption', 'n-distribution'],
  ['n-free-evaluation', 'n-standard'],
  ['n-obstruction', 'n-experience'],
  ['n-claim-burden', 'n-evidence-deadline'],
  ['n-principal-evidence', 'n-counter-evidence'],
];

export function createDemoDoc(now = Date.now()): KnowledgeDoc {
  const nodes: KnowledgeNode[] = DEMO_NODE_SEEDS.map((seed) => {
    const match = findQuote(DEMO_TEXT, seed.quote);
    return {
      id: seed.id,
      title: seed.title,
      quote: seed.quote,
      quoteStart: match.matched ? match.start : -1,
      quoteEnd: match.matched ? match.end : -1,
      question: seed.question,
      parentId: seed.parentId,
      level: seed.level,
      mastery: seed.mastery,
      goodStreak: seed.goodStreak,
      lastReviewedAt:
        seed.reviewedOffsetDays === null ? null : now - seed.reviewedOffsetDays * DAY_MS,
      nextReviewAt: now + seed.dueOffsetDays * DAY_MS,
    };
  });

  const relations: Relation[] = DEMO_RELATION_SEEDS.map(([from, to]) => ({ from, to }));

  return {
    id: DEMO_DOC_ID,
    title: '证据法讲义 · 证明责任',
    text: DEMO_TEXT,
    origin: 'demo',
    createdAt: now - 3 * DAY_MS,
    updatedAt: now,
    nodes,
    relations,
  };
}
