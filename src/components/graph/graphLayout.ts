import type { GraphView, KnowledgeDoc, KnowledgeNode, Relation } from '../../lib/types';

export type { GraphView };

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

const TWO_PI = Math.PI * 2;
/** 四条旋臂，贴近银河系这类棒旋星系的典型结构 */
export const GALAXY_ARMS = 4;
const MAX_RADIUS = 1.2;

/** 稳定哈希：同一个 id 永远得到同一个 0–1 值，拖动、重绘、刷新都不会让星星乱跳 */
export function hash01(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

/**
 * 星系盘布局：核心居中，一级节点沿两条旋臂向外铺开，
 * 子节点顺着父母的旋臂继续外扩，越往外旋臂越散、盘面越薄。
 * x/z 构成盘面，y 只保留很小的厚度，旋转时像一张倾斜的星盘。
 */
export function computeGalaxyLayout(nodes: KnowledgeNode[]): Record<string, SpherePoint> {
  const points: Record<string, SpherePoint> = {};
  if (nodes.length === 0) {
    return points;
  }

  const ids = new Set(nodes.map((node) => node.id));
  const core = nodes.find((node) => node.parentId === null) ?? nodes[0];
  points[core.id] = { x: 0, y: 0, z: 0 };

  const childrenOf = new Map<string, KnowledgeNode[]>();
  nodes.forEach((node) => {
    if (node.id === core.id) {
      return;
    }
    const parentId =
      node.parentId && ids.has(node.parentId) && node.parentId !== node.id ? node.parentId : core.id;
    const list = childrenOf.get(parentId) ?? [];
    list.push(node);
    childrenOf.set(parentId, list);
  });

  const meta = new Map<string, { radius: number; theta: number }>();

  const place = (id: string, radius: number, theta: number) => {
    const angleJitter = (hash01(`${id}:angle`) - 0.5) * 0.14;
    const finalTheta = theta + angleJitter;
    const thickness = 0.018 + radius * 0.055;
    const y = (hash01(`${id}:height`) - 0.5) * 2 * thickness;
    points[id] = {
      x: Math.cos(finalTheta) * radius,
      y,
      z: Math.sin(finalTheta) * radius,
    };
    meta.set(id, { radius, theta: finalTheta });
  };

  // 一级节点：角度均分保证小图也均衡，半径沿旋臂轻微递进，整体再带一点旋臂偏角
  const direct = childrenOf.get(core.id) ?? [];
  direct.forEach((node, index) => {
    const base = (index / Math.max(1, direct.length)) * TWO_PI + 0.35;
    const t = direct.length <= 1 ? 0.5 : index / (direct.length - 1);
    const radius = 0.44 + t * 0.2;
    place(node.id, radius, base + radius * 0.65);
  });

  // 更深层级：顺着父母的旋臂向外延伸，同层兄弟在臂上轻微散开
  const queue = [...direct];
  const handled = new Set<string>();
  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (handled.has(parent.id)) {
      continue;
    }
    handled.add(parent.id);
    const parentMeta = meta.get(parent.id);
    if (!parentMeta) {
      continue;
    }
    const children = childrenOf.get(parent.id) ?? [];
    children.forEach((child, index) => {
      if (points[child.id]) {
        return;
      }
      const spread = children.length <= 1 ? 0 : (index - (children.length - 1) / 2) * 0.19;
      const radius = Math.min(MAX_RADIUS, parentMeta.radius + 0.16 + (index % 2) * 0.04);
      place(child.id, radius, parentMeta.theta + spread + (radius - parentMeta.radius) * 1.15);
      queue.push(child);
    });
  }

  // 环状引用等兜底：放到最外圈，保证每个节点都有位置
  nodes.forEach((node, index) => {
    if (points[node.id]) {
      return;
    }
    const theta = (index / Math.max(nodes.length, 1)) * TWO_PI + 0.4;
    place(node.id, MAX_RADIUS, theta);
  });

  return points;
}

function buildHierarchy(nodes: KnowledgeNode[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const root = nodes.find((node) => node.parentId === null) ?? nodes[0];
  const childrenOf = new Map<string, KnowledgeNode[]>();
  nodes.forEach((node) => {
    if (node.id === root.id) {
      return;
    }
    const parentId =
      node.parentId && ids.has(node.parentId) && node.parentId !== node.id ? node.parentId : root.id;
    const children = childrenOf.get(parentId) ?? [];
    children.push(node);
    childrenOf.set(parentId, children);
  });
  return { root, childrenOf };
}

function computeRadialLayout(nodes: KnowledgeNode[]): Record<string, SpherePoint> {
  const { root, childrenOf } = buildHierarchy(nodes);
  const points: Record<string, SpherePoint> = { [root.id]: { x: 0, y: 0, z: 0 } };
  const queue = [{ id: root.id, depth: 0, start: 0, end: TWO_PI }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (visited.has(parent.id)) {
      continue;
    }
    visited.add(parent.id);
    const children = childrenOf.get(parent.id) ?? [];
    const slice = (parent.end - parent.start) / Math.max(1, children.length);
    children.forEach((child, index) => {
      if (points[child.id]) {
        return;
      }
      const start = parent.start + slice * index;
      const end = start + slice;
      const angle = (start + end) / 2 - Math.PI / 2;
      const radius = Math.min(MAX_RADIUS, (parent.depth + 1) * 0.36);
      points[child.id] = {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        z: 0,
      };
      queue.push({ id: child.id, depth: parent.depth + 1, start, end });
    });
  }

  nodes.forEach((node, index) => {
    if (!points[node.id]) {
      const angle = (index / nodes.length) * TWO_PI;
      points[node.id] = { x: Math.cos(angle) * MAX_RADIUS, y: Math.sin(angle) * MAX_RADIUS, z: 0 };
    }
  });
  return points;
}

function computeTreeLayout(nodes: KnowledgeNode[]): Record<string, SpherePoint> {
  const { root, childrenOf } = buildHierarchy(nodes);
  const depths = new Map<string, number>();
  const rows = new Map<string, number>();
  const visited = new Set<string>();
  let leafIndex = 0;
  let maxDepth = 0;

  const place = (id: string, depth: number) => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    depths.set(id, depth);
    maxDepth = Math.max(maxDepth, depth);
    const children = (childrenOf.get(id) ?? []).filter((child) => !visited.has(child.id));
    if (children.length === 0) {
      rows.set(id, leafIndex);
      leafIndex += 1;
      return;
    }
    children.forEach((child) => place(child.id, depth + 1));
    const childRows = children.map((child) => rows.get(child.id) ?? 0);
    rows.set(id, childRows.reduce((sum, row) => sum + row, 0) / childRows.length);
  };

  place(root.id, 0);
  nodes.forEach((node) => place(node.id, 0));
  const points: Record<string, SpherePoint> = {};
  nodes.forEach((node) => {
    const depth = depths.get(node.id) ?? 0;
    const row = rows.get(node.id) ?? 0;
    points[node.id] = {
      x: maxDepth === 0 ? 0 : -1.05 + (depth / maxDepth) * 2.1,
      y: leafIndex <= 1 ? 0 : (row / (leafIndex - 1) - 0.5) * 2,
      z: 0,
    };
  });
  return points;
}

function computeTimelineLayout(doc: KnowledgeDoc): Record<string, SpherePoint> {
  const ordered = doc.nodes
    .map((node, index) => ({ node, index, time: node.lastReviewedAt ?? doc.createdAt }))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  const points: Record<string, SpherePoint> = {};
  ordered.forEach(({ node }, index) => {
    const lane = index % 3;
    points[node.id] = {
      x: ordered.length <= 1 ? 0 : -1.08 + (index / (ordered.length - 1)) * 2.16,
      y: lane === 0 ? -0.42 : lane === 1 ? 0 : 0.42,
      z: 0,
    };
  });
  return points;
}

export function computeGraphLayout(
  doc: KnowledgeDoc,
  view: GraphView,
): Record<string, SpherePoint> {
  if (doc.nodes.length === 0) {
    return {};
  }
  if (view === 'galaxy') {
    return computeGalaxyLayout(doc.nodes);
  }
  if (view === 'radial') {
    return computeRadialLayout(doc.nodes);
  }
  if (view === 'tree') {
    return computeTreeLayout(doc.nodes);
  }
  return computeTimelineLayout(doc);
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
