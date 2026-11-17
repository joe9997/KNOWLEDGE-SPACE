import { STATUS_LABEL, statusOf } from './review';
import type { KnowledgeDoc, KnowledgeNode } from './types';

const ORIGIN_LABEL: Record<KnowledgeDoc['origin'], string> = {
  demo: '体验材料',
  local: '本地规则整理（不调用 AI）',
  ai: 'AI 抽取',
};

function sortTree(nodes: KnowledgeNode[]): KnowledgeNode[] {
  const childrenOf = (parentId: string | null) =>
    nodes.filter((node) => node.parentId === parentId);

  const ordered: KnowledgeNode[] = [];
  const walk = (parentId: string | null) => {
    childrenOf(parentId).forEach((node) => {
      ordered.push(node);
      walk(node.id);
    });
  };
  walk(null);
  // 防御：有环或孤立节点时仍导出
  nodes.forEach((node) => {
    if (!ordered.includes(node)) {
      ordered.push(node);
    }
  });
  return ordered;
}

export function buildMarkdown(doc: KnowledgeDoc, now = Date.now()): string {
  const nodes = sortTree(doc.nodes);
  const lines: string[] = [];
  lines.push(`# ${doc.title}`, '');
  lines.push(`> 由「回源 · KNOWLEDGE SPACE」导出 · ${new Date(now).toLocaleString('zh-CN')}`);
  lines.push(`> 来源：${ORIGIN_LABEL[doc.origin]}`);
  lines.push(`> 概念 ${doc.nodes.length} 个 · 关联 ${countRelations(doc)} 条`, '');

  lines.push('## 知识节点', '');
  for (const node of nodes) {
    const indent = '  '.repeat(Math.min(3, node.level));
    const status = STATUS_LABEL[statusOf(node, now)];
    lines.push(`${indent}- **${node.title}** · ${status}`);
    if (node.question) {
      lines.push(`${indent}  - 问：${node.question}`);
    }
    lines.push(
      `${indent}  - 原文：${node.quoteStart >= 0 ? node.quote : '无出处（未找到可逐字匹配的原句）'}`,
    );
  }

  lines.push('', '## 原文', '', doc.text, '');
  return lines.join('\n');
}

export function countRelations(doc: KnowledgeDoc): number {
  return doc.nodes.filter((node) => node.parentId).length + doc.relations.length;
}

export function downloadMarkdown(doc: KnowledgeDoc, now = Date.now()): void {
  const content = buildMarkdown(doc, now);
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${doc.title.replace(/[\\/:*?"<>|]/g, '_') || '回源笔记'}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
