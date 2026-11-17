import type { GraphPosition, KnowledgeNode, Relation } from '../../lib/types';

export interface GraphLink {
  from: string;
  to: string;
  kind: 'tree' | 'relation';
}

/** 核心在中心，直接子节点围绕一圈，孙节点在父节点外侧 */
export function computeGraphLayout(nodes: KnowledgeNode[]): Record<string, GraphPosition> {
  const positions: Record<string, GraphPosition> = {};
  if (nodes.length === 0) {
    return positions;
  }

  const core = nodes.find((node) => node.parentId === null) ?? nodes[0];
  positions[core.id] = { x: 0, y: 0 };

  const direct = nodes.filter(
    (node) => node.id !== core.id && (node.parentId === core.id || !node.parentId),
  );
  const directIds = new Set(direct.map((node) => node.id));
  const ring1 = direct.length > 10 ? 240 : direct.length > 8 ? 215 : 195;
  const startAngle = -Math.PI / 2;

  const directAngles = new Map<string, number>();
  direct.forEach((node, index) => {
    const angle = startAngle + (index / Math.max(direct.length, 1)) * Math.PI * 2;
    directAngles.set(node.id, angle);
    const radius = ring1 + (index % 2 === 0 ? 0 : 12);
    positions[node.id] = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });

  const grandchildren = nodes.filter(
    (node) => node.parentId !== null && node.parentId !== core.id && directIds.has(node.parentId),
  );
  const grandByParent = new Map<string, KnowledgeNode[]>();
  grandchildren.forEach((node) => {
    const list = grandByParent.get(node.parentId!) ?? [];
    list.push(node);
    grandByParent.set(node.parentId!, list);
  });

  grandByParent.forEach((children, parentId) => {
    const parentAngle = directAngles.get(parentId) ?? 0;
    const spread = 0.34;
    children.forEach((node, index) => {
      const offset = children.length === 1 ? 0 : (index - (children.length - 1) / 2) * spread;
      const angle = parentAngle + offset;
      const radius = ring1 + 85 + index * 6;
      positions[node.id] = {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
    });
  });

  // 孤立节点或环上的节点：放在最外圈，保证可见
  const remaining = nodes.filter((node) => !positions[node.id]);
  remaining.forEach((node, index) => {
    const angle = startAngle + (index / Math.max(remaining.length, 1)) * Math.PI * 2 + 0.3;
    const radius = ring1 + 160;
    positions[node.id] = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });

  return positions;
}

export function buildGraphLinks(nodes: KnowledgeNode[], relations: Relation[]): GraphLink[] {
  const links: GraphLink[] = [];
  const ids = new Set(nodes.map((node) => node.id));
  nodes.forEach((node) => {
    if (node.parentId && ids.has(node.parentId)) {
      links.push({ from: node.parentId, to: node.id, kind: 'tree' });
    }
  });
  relations.forEach((relation) => {
    if (ids.has(relation.from) && ids.has(relation.to)) {
      links.push({ from: relation.from, to: relation.to, kind: 'relation' });
    }
  });
  return links;
}

export function curvePath(
  from: GraphPosition,
  to: GraphPosition,
  bend = 0.075,
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const controlX = midX + (-dy / length) * length * bend;
  const controlY = midY + (dx / length) * length * bend;
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} Q ${controlX.toFixed(2)} ${controlY.toFixed(
    2,
  )} ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

export function nodeTransform(position: GraphPosition): string {
  return `translate(-50%, -50%) translate(${position.x}px, ${position.y}px)`;
}

export function layoutExtent(positions: Record<string, GraphPosition>): {
  width: number;
  height: number;
} {
  let maxX = 0;
  let maxY = 0;
  Object.values(positions).forEach((position) => {
    maxX = Math.max(maxX, Math.abs(position.x));
    maxY = Math.max(maxY, Math.abs(position.y));
  });
  return { width: maxX * 2 + 160, height: maxY * 2 + 120 };
}
