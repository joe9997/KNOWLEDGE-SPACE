import type { KnowledgeNode, Relation } from '../../lib/types';

export interface GraphLink {
  from: string;
  to: string;
  kind: 'tree' | 'relation';
}

export interface SpherePoint {
  x: number;
  y: number;
  z: number;
}

function sphere(phi: number, theta: number): SpherePoint {
  return {
    x: Math.sin(phi) * Math.cos(theta),
    y: Math.sin(phi) * Math.sin(theta),
    z: Math.cos(phi),
  };
}

/** 节点分布在球面上：核心在正面，子节点和孙节点依次向外圈铺开 */
export function computeSphereLayout(nodes: KnowledgeNode[]): Record<string, SpherePoint> {
  const points: Record<string, SpherePoint> = {};
  if (nodes.length === 0) {
    return points;
  }

  const core = nodes.find((node) => node.parentId === null) ?? nodes[0];
  points[core.id] = { x: 0, y: 0, z: 1 };

  const direct = nodes.filter(
    (node) => node.id !== core.id && (node.parentId === core.id || !node.parentId),
  );
  const directIds = new Set(direct.map((node) => node.id));
  const angles = new Map<string, number>();

  direct.forEach((node, index) => {
    const theta = (index / Math.max(direct.length, 1)) * Math.PI * 2;
    const phi = 0.92 + (index % 2 === 0 ? 0 : 0.07);
    angles.set(node.id, theta);
    points[node.id] = sphere(phi, theta);
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
    const parentTheta = angles.get(parentId) ?? 0;
    children.forEach((node, index) => {
      const offset = children.length === 1 ? 0 : (index - (children.length - 1) / 2) * 0.4;
      points[node.id] = sphere(1.58 + index * 0.05, parentTheta + offset);
    });
  });

  // 更深层级或孤立节点放到球体背面一圈，旋转时仍可看到
  const remaining = nodes.filter((node) => !points[node.id]);
  remaining.forEach((node, index) => {
    const theta = (index / Math.max(remaining.length, 1)) * Math.PI * 2 + 0.4;
    points[node.id] = sphere(2.28, theta);
  });

  return points;
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
