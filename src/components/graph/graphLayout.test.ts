import { describe, expect, it } from 'vitest';
import type { KnowledgeDoc, KnowledgeNode } from '../../lib/types';
import { computeGalaxyLayout, computeGraphLayout, type GraphView } from './graphLayout';

function makeNode(
  id: string,
  parentId: string | null,
  lastReviewedAt: number | null = null,
): KnowledgeNode {
  return {
    id,
    title: id,
    question: `问题 ${id}`,
    quote: id,
    quoteStart: 0,
    quoteEnd: id.length,
    parentId,
    level: parentId === null ? 0 : 1,
    mastery: 0,
    goodStreak: 0,
    lastReviewedAt,
    nextReviewAt: 0,
  };
}

function makeDoc(nodes: KnowledgeNode[]): KnowledgeDoc {
  return {
    id: 'doc',
    title: '测试资料',
    text: 'root a b a1',
    origin: 'local',
    createdAt: 100,
    updatedAt: 100,
    nodes,
    relations: [],
  };
}

const DOC = makeDoc([
  makeNode('root', null, 300),
  makeNode('a', 'root'),
  makeNode('b', 'root', 200),
  makeNode('a1', 'a'),
]);
const VIEWS: GraphView[] = ['galaxy', 'radial', 'tree', 'timeline'];

describe('computeGraphLayout', () => {
  it.each(VIEWS)('%s 视图覆盖所有节点且坐标有限', (view) => {
    const points = computeGraphLayout(DOC, view);
    expect(Object.keys(points).sort()).toEqual(DOC.nodes.map((node) => node.id).sort());
    Object.values(points).forEach((point) => {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(Number.isFinite(point.z)).toBe(true);
    });
  });

  it('空文档返回空布局，星系视图保留原有坐标', () => {
    expect(computeGraphLayout(makeDoc([]), 'radial')).toEqual({});
    expect(computeGraphLayout(DOC, 'galaxy')).toEqual(computeGalaxyLayout(DOC.nodes));
  });

  it('辐射图以根节点为中心，子节点随层级向外展开', () => {
    const points = computeGraphLayout(DOC, 'radial');
    expect(points.root).toEqual({ x: 0, y: 0, z: 0 });
    const radius = (id: string) => Math.hypot(points[id].x, points[id].y);
    expect(radius('a1')).toBeGreaterThan(radius('a'));
    expect(radius('a')).toBeGreaterThan(radius('root'));
  });

  it('树形图按深度从左向右排列，并分开不同叶子', () => {
    const points = computeGraphLayout(DOC, 'tree');
    expect(points.root.x).toBeLessThan(points.a.x);
    expect(points.a.x).toBeLessThan(points.a1.x);
    expect(points.a1.y).not.toBe(points.b.y);
  });

  it('时间线按最后复习时间排序，未复习节点使用资料创建时间', () => {
    const points = computeGraphLayout(DOC, 'timeline');
    const ordered = DOC.nodes.map((node) => node.id).sort((a, b) => points[a].x - points[b].x);
    expect(ordered).toEqual(['a', 'a1', 'b', 'root']);
  });
});
