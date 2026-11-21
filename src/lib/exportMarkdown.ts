import { STATUS_LABEL, statusOf } from './review';
import type { KnowledgeDoc, KnowledgeNode } from './types';

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

export function countRelations(doc: KnowledgeDoc): number {
  return doc.nodes.filter((node) => node.parentId).length + doc.relations.length;
}

// ---------- PDF 导出 ----------
// 零依赖方案：生成结构化打印 HTML → 打开新窗口 → 调起浏览器打印（用户选"另存为 PDF"）

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把一段文本里的 **加粗** 转为 <strong>，其余按 HTML 转义 */
function renderInlineHtml(text: string): string {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part) => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
      }
      return escapeHtml(part);
    })
    .join('');
}

function buildPrintableHtml(doc: KnowledgeDoc, now: number): string {
  const nodes = sortTree(doc.nodes);
  const dateStr = new Date(now).toLocaleString('zh-CN');
  const traceable = nodes.filter((n) => n.quoteStart >= 0).length;

  const nodeSections = nodes
    .map((node, index) => {
      const status = STATUS_LABEL[statusOf(node, now)];
      const level = Math.min(3, node.level);
      const question = node.question
        ? `<p class="q"><span class="lbl">问</span>${renderInlineHtml(node.question)}</p>`
        : '';
      const quote =
        node.quoteStart >= 0
          ? `<blockquote class="quote">${renderInlineHtml(node.quote)}</blockquote>`
          : `<p class="no-quote">无出处（未找到可逐字匹配的原句）</p>`;
      const explanation = node.explanation
        ? `<p class="exp"><span class="lbl">讲解</span>${renderInlineHtml(node.explanation)}</p>`
        : '';
      return `
<section class="node level-${level}">
  <h3><span class="idx">${String(index + 1).padStart(2, '0')}</span>${renderInlineHtml(node.title)}<span class="chip">${status}</span></h3>
  ${question}
  ${quote}
  ${explanation}
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(doc.title)} · 回源笔记</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "PingFang SC","Microsoft YaHei","Source Han Serif SC","Noto Serif CJK SC",serif;
    color: #1a1a1a; line-height: 1.75; font-size: 11.5pt;
    background: #fff;
  }
  .cover { border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 24px; }
  .cover .brand { font-size: 10pt; letter-spacing: 4px; color: #666; text-transform: uppercase; }
  .cover h1 { font-size: 24pt; margin: 6px 0 10px; line-height: 1.3; }
  .cover .meta { font-size: 10pt; color: #555; }
  .cover .meta span + span::before { content: " · "; color: #999; margin: 0 4px; }
  h2 {
    font-size: 14pt; margin: 28px 0 12px; padding-bottom: 6px;
    border-bottom: 1px solid #ddd; color: #222;
  }
  .node { margin-bottom: 18px; page-break-inside: avoid; }
  .node.level-1 { margin-left: 14px; }
  .node.level-2 { margin-left: 28px; }
  .node.level-3 { margin-left: 42px; }
  .node h3 {
    font-size: 12.5pt; margin: 0 0 6px; color: #111;
    display: flex; align-items: baseline; gap: 8px;
  }
  .node .idx { color: #999; font-weight: normal; font-size: 10pt; }
  .node .chip {
    margin-left: auto; font-size: 9pt; color: #555;
    border: 1px solid #ccc; padding: 1px 6px; border-radius: 999px;
  }
  .node .q { margin: 4px 0; color: #333; }
  .node .lbl {
    display: inline-block; font-size: 9pt; color: #555;
    border: 1px solid #ccc; padding: 0 5px; border-radius: 4px;
    margin-right: 6px; vertical-align: 1px;
  }
  .node .quote {
    margin: 6px 0 0; padding: 8px 12px;
    border-left: 3px solid #888; background: #f7f7f7;
    color: #333; font-style: normal;
  }
  .node .no-quote { color: #999; font-size: 10pt; margin: 4px 0 0; }
  .node .exp { margin: 6px 0 0; color: #444; font-size: 11pt; }
  .source-text {
    white-space: pre-wrap; word-break: break-word;
    font-size: 10.5pt; color: #333; line-height: 1.85;
  }
  strong { color: #000; font-weight: 600; }
  @media print {
    .node { page-break-inside: avoid; }
    h2 { page-break-after: avoid; }
  }
</style>
</head>
<body>
  <header class="cover">
    <div class="brand">KNOWLEDGE SPACE · 回源</div>
    <h1>${escapeHtml(doc.title)}</h1>
    <div class="meta">
      <span>${doc.subtitle ? escapeHtml(doc.subtitle) : '学习笔记'}</span>
      <span>概念 ${nodes.length} 个</span>
      <span>关联 ${countRelations(doc)} 条</span>
      <span>可溯源 ${traceable}/${nodes.length}</span>
      <span>导出于 ${dateStr}</span>
    </div>
  </header>

  <h2>知识节点</h2>
  ${nodeSections}

  <h2>原文</h2>
  <div class="source-text">${escapeHtml(doc.text)}</div>

  <script>
    // 自动触发打印对话框，用户在系统弹窗里选"另存为 PDF"
    window.addEventListener('load', () => {
      setTimeout(() => window.print(), 250);
    });
  </script>
</body>
</html>`;
}

/** 导出 PDF：打开新窗口渲染打印视图，由浏览器"另存为 PDF" */
export function downloadPdf(doc: KnowledgeDoc, now = Date.now()): void {
  const printWindow = window.open('', '_blank', 'width=900,height=1200');
  if (!printWindow) {
    window.alert('浏览器拦截了新窗口，请允许本站弹窗后重试导出 PDF。');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(buildPrintableHtml(doc, now));
  printWindow.document.close();
}
