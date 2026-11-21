import { describe, expect, it } from 'vitest';
import { buildDocMeta, deriveDocTitle, extractLocally, toKnowledgeNodes } from '../localExtract';
import { buildAutoStudyBrief, buildLocalAssistantReply } from '../assistant';
import { findQuote } from '../quotes';
import type { KnowledgeDoc } from '../types';

const HEADED = `# 合同法讲义

合同是当事人之间设立、变更、终止民事权利义务关系的协议。合同成立需要要约与承诺。

## 要约

要约是希望与他人订立合同的意思表示。要约到达受要约人时生效。

## 承诺

承诺是受要约人同意要约的意思表示。承诺生效时合同成立。`;

const PLAIN = `记忆分为感觉记忆、短时记忆与长时记忆。感觉记忆保持时间极短，通常不足一秒。
短时记忆的容量大约为七个组块。通过复述，短时记忆可以进入长时记忆。
长时记忆的提取依赖线索，线索越丰富，回忆越容易。`;

const PAPER = `FAST-Calib: LiDAR-Camera Extrinsic Calibration in One Second
Chunran Zheng 1 and Fu Zhang 1
Abstract — This paper proposes FAST-Calib, a fast and user-friendly LiDAR-camera extrinsic calibration tool based on a custom-made 3D target. FAST-Calib supports both static and dynamic calibration. The method requires only one second of data.
1 Introduction
LiDAR-camera calibration is essential for autonomous driving and robotics. Existing target-based methods are accurate but slow. We propose a novel calibration framework that estimates the extrinsic parameters in one shot.
2 Method
The proposed pipeline detects the target from the point cloud and the image. We design a coarse-to-fine optimization to refine the extrinsic matrix.
3 Experiments
Experimental results show that the proposed method achieves 0.2 cm accuracy. The average calibration time is about one second.
4 Conclusion
We present a fast and accurate calibration tool. The method is robust to different sensors.
References
[1] Some paper. 2020.`;

describe('本地规则整理', () => {
  it('按 Markdown 标题创建节点，引用是完整原句', () => {
    const extracted = extractLocally(HEADED);
    expect(extracted.length).toBeGreaterThanOrEqual(3);
    expect(extracted[0].title).toContain('合同法');
    expect(extracted[1].title).toBe('要约');
    extracted.forEach((node) => {
      expect(findQuote(HEADED, node.quote).matched).toBe(true);
    });
  });

  it('没有标题时按完整句子抽取', () => {
    const extracted = extractLocally(PLAIN);
    expect(extracted.length).toBeGreaterThanOrEqual(4);
    extracted.forEach((node) => {
      expect(findQuote(PLAIN, node.quote).matched).toBe(true);
      expect(node.question.length).toBeGreaterThan(4);
    });
  });

  it('补齐节点时建立父子层级', () => {
    const extracted = extractLocally(HEADED);
    const nodes = toKnowledgeNodes(extracted, HEADED, 1000);
    expect(nodes[0].parentId).toBeNull();
    const offer = nodes.find((node) => node.title === '要约');
    expect(offer?.parentId).toBe(nodes[0].id);
    nodes.forEach((node) => {
      expect(node.quoteStart).toBeGreaterThanOrEqual(0);
      expect(node.nextReviewAt).toBe(1000);
    });
  });

  it('无法逐字匹配的引用被标记为无出处', () => {
    const nodes = toKnowledgeNodes(
      [{ title: '编造节点', quote: '这句话不存在于材料中。', question: '测试？', level: 0 }],
      PLAIN,
      1000,
    );
    expect(nodes[0].quoteStart).toBe(-1);
    expect(nodes[0].quoteEnd).toBe(-1);
  });

  it('英文论文也能抽出多个要点，且引用逐字匹配', () => {
    const extracted = extractLocally(PAPER);
    expect(extracted.length).toBeGreaterThanOrEqual(8);
    extracted.forEach((node) => {
      expect(node.title.trim().length).toBeGreaterThan(0);
      expect(node.quote.length).toBeGreaterThan(20);
      expect(findQuote(PAPER, node.quote).matched).toBe(true);
    });
    expect(extracted.some((node) => /FAST-Calib/.test(node.title + node.quote))).toBe(true);
  });

  it('句首连接词不会变成节点标题', () => {
    const text = [
      'However, the proposed method still fails on reflective surfaces.',
      'In this section, we describe the calibration target and its geometry.',
      'Moreover, the system runs in real time on a standard laptop.',
      'Therefore, we adopt a coarse-to-fine strategy for the optimization.',
    ].join(' ');
    const extracted = extractLocally(text);
    expect(extracted.length).toBeGreaterThanOrEqual(3);
    extracted.forEach((node) => {
      expect(node.title).not.toMatch(/^(however|moreover|therefore|in this section)$/i);
      expect(node.title.length).toBeGreaterThan(4);
    });
  });

  it('粘贴双语单词笔记时自动总结标题', () => {
    const notes = `The report reframes the issue as a question of fairness rather than efficiency.
译文：这份报告把问题重新界定为公平问题，而不是效率问题。
distill /dɪˈstɪl/ v. 提炼；浓缩
The summary distills a long report into five key points.
译文：这份摘要把一份长篇报告提炼成五个要点。
lucid /ˈluːsɪd/ adj. 清晰易懂的；头脑清醒的
She gave a lucid explanation of a complicated policy.
译文：她对一项复杂的政策作了清晰易懂的解释。`;
    const title = deriveDocTitle(notes);
    expect(title).toContain('distill');
    expect(title).toContain('lucid');
    expect(title.length).toBeLessThanOrEqual(44);
  });

  it('本地学习技能：闪卡与诊断', () => {
    const nodes = toKnowledgeNodes(extractLocally(PAPER), PAPER, 1000);
    const doc = {
      id: 'd1',
      title: 'FAST-Calib',
      text: PAPER,
      origin: 'local',
      createdAt: 0,
      updatedAt: 0,
      nodes,
      relations: [],
    } as KnowledgeDoc;
    const cards = buildLocalAssistantReply(doc, '帮我生成闪卡') ?? '';
    expect(cards).toContain('正面：');
    expect(cards).toContain('背面：');
    expect(buildLocalAssistantReply(doc, '诊断一下我的薄弱点') ?? '').toContain('学习诊断');
    expect(buildLocalAssistantReply(doc, '考前突击怎么安排') ?? '').toContain('考前突击');
  });

  it('单词笔记的讲解包含释义、例句，并能纠正拼写', () => {
    const text = `manifest /ˈmænɪfest/ v. 显示；表明
The problem manifests itself in different ways across regions.
ascribe /əˈskraɪb/ v. 归因于`;
    const base = {
      id: 'n1',
      question: '问？',
      quoteStart: 0,
      quoteEnd: 0,
      level: 1,
      mastery: 0 as const,
      goodStreak: 0,
      lastReviewedAt: null,
      nextReviewAt: 0,
    };
    const doc = {
      id: 'd2',
      title: '111',
      text,
      origin: 'local',
      createdAt: 0,
      updatedAt: 0,
      relations: [],
      nodes: [
        { ...base, id: 'a', title: 'manifest 的用法', quote: 'The problem manifests itself.', parentId: null },
        { ...base, id: 'b', title: 'ascibe 的常见错误', quote: '', parentId: 'a' },
      ],
    } as KnowledgeDoc;
    const brief = buildAutoStudyBrief(doc) ?? '';
    expect(brief).toContain('manifest');
    expect(brief).toContain('显示');
    expect(brief).toContain('例：');
    // 标题拼错 ascibe，也要匹配到 ascribe 的释义
    expect(brief).toContain('归因于');
  });

  it('自动生成副标题与摘要', () => {
    const meta = buildDocMeta(PAPER);
    expect(meta.subtitle).toContain('FAST-Calib');
    expect(meta.summary).toContain('This paper proposes');
    expect(meta.summary.length).toBeLessThanOrEqual(200);
  });

  it('重复标题会生成唯一标题，避免覆盖', () => {
    const nodes = toKnowledgeNodes(
      [
        { title: '概念', quote: '感觉记忆保持时间极短，通常不足一秒。', question: '问？', level: 0 },
        { title: '概念', quote: '短时记忆的容量大约为七个组块。', question: '问？', level: 1 },
      ],
      PLAIN,
      1000,
    );
    expect(nodes[0].title).not.toBe(nodes[1].title);
  });
});
