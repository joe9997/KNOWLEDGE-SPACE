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
