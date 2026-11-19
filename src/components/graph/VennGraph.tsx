import { useEffect, useMemo, useState } from 'react';
import { DAY_MS, isDue } from '../../lib/review';
import type { KnowledgeDoc, KnowledgeNode } from '../../lib/types';
import { paletteVariant } from '../../lib/learningPrefs';
import type { PaletteTheme } from '../../lib/learningPrefs';

interface VennGraphProps {
  doc: KnowledgeDoc;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 演示时间偏移（天），与星系视图共用同一个“现在” */
  offsetDays: number;
  paletteTheme: PaletteTheme;
}

interface VennGroup {
  key: string;
  title: string;
  nodes: KnowledgeNode[];
}

const VIEW_W = 680;
const VIEW_H = 500;
const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2;
const CIRCLE_R = 168;
const CENTER_OFFSET = 88;
const MAX_PER_GROUP = 8;
const LABEL_MAX = 6;

/** 按一级分支把节点分进最多三个集合；分支太少时退化为均分 */
function buildGroups(doc: KnowledgeDoc): VennGroup[] {
  const nodes = doc.nodes;
  if (nodes.length <= 1) {
    return [];
  }
  const root = nodes.find((node) => node.parentId === null) ?? nodes[0];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = nodes.filter((node) => node.parentId === root.id);
  const nonRoot = nodes.filter((node) => node.id !== root.id);

  if (children.length >= 2) {
    const groups: VennGroup[] = children.slice(0, 3).map((seed) => ({
      key: seed.id,
      title: seed.title,
      nodes: [],
    }));
    const groupOf = new Map(groups.map((group) => [group.key, group]));

    const topAncestor = (node: KnowledgeNode): string => {
      let cursor = node;
      for (let depth = 0; depth < 16; depth += 1) {
        const parent = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        if (!parent || parent.id === root.id) {
          return cursor.id;
        }
        cursor = parent;
      }
      return cursor.id;
    };

    nonRoot.forEach((node) => {
      const group =
        groupOf.get(topAncestor(node)) ??
        groups.reduce((smallest, current) =>
          current.nodes.length < smallest.nodes.length ? current : smallest,
        );
      group.nodes.push(node);
    });
    return groups;
  }

  const count = Math.min(3, Math.max(1, Math.ceil(nonRoot.length / 3)));
  const groups: VennGroup[] = nonRoot.slice(0, count).map((node) => ({
    key: node.id,
    title: node.title,
    nodes: [node],
  }));
  nonRoot.slice(count).forEach((node, index) => {
    groups[index % groups.length].nodes.push(node);
  });
  return groups;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function VennGraph({
  doc,
  selectedId,
  onSelect,
  offsetDays,
  paletteTheme,
}: VennGraphProps) {
  const [light, setLight] = useState(
    () => document.documentElement.dataset.theme === 'light',
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setLight(document.documentElement.dataset.theme === 'light');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const root = doc.nodes.find((node) => node.parentId === null) ?? doc.nodes[0] ?? null;
    const groups = buildGroups(doc);
    const angles =
      groups.length === 1 ? [0] : groups.length === 2 ? [-90, 90] : [-90, 30, 150];

    const circles = groups.map((group, index) => {
      const angle = (angles[index] ?? 0) * (Math.PI / 180);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cx = CENTER_X + cos * CENTER_OFFSET;
      const cy = CENTER_Y + sin * CENTER_OFFSET;
      const lobeDistance = CENTER_OFFSET + CIRCLE_R * 0.5;
      const lobeX = CENTER_X + cos * lobeDistance;
      const lobeY = CENTER_Y + sin * lobeDistance;

      const shown = group.nodes.slice(0, MAX_PER_GROUP);
      const columns = shown.length <= 2 ? 1 : 2;
      const rows = Math.max(1, Math.ceil(shown.length / columns));
      const positions = shown.map((node, nodeIndex) => {
        const column = nodeIndex % columns;
        const row = Math.floor(nodeIndex / columns);
        return {
          node,
          x: lobeX + (column - (columns - 1) / 2) * 64,
          y: lobeY + (row - (rows - 1) / 2) * 30,
        };
      });

      return {
        group,
        angle,
        cx,
        cy,
        positions,
        hidden: Math.max(0, group.nodes.length - shown.length),
      };
    });

    const positionsById = new Map<string, { x: number; y: number }>();
    circles.forEach((circle) => {
      circle.positions.forEach((item) => {
        positionsById.set(item.node.id, { x: item.x, y: item.y });
      });
    });
    if (root) {
      positionsById.set(root.id, { x: CENTER_X, y: CENTER_Y });
    }

    const relations = doc.relations.filter(
      (relation) =>
        relation.from !== relation.to &&
        positionsById.has(relation.from) &&
        positionsById.has(relation.to),
    );

    return { root, circles, positionsById, relations };
  }, [doc]);

  const now = Date.now() + offsetDays * DAY_MS;

  return (
    <div className="venn-shell">
      <svg
        className="venn-graph"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`韦恩图：${doc.title}`}
      >
        {layout.circles.map((circle) => {
          const labelX = circle.cx + Math.cos(circle.angle) * CIRCLE_R * 0.74;
          const labelY = circle.cy + Math.sin(circle.angle) * CIRCLE_R * 0.74;
          return (
            <g key={`circle-${circle.group.key}`} className="venn-set">
              <circle
                cx={circle.cx}
                cy={circle.cy}
                r={CIRCLE_R}
                className="venn-set__disc"
              />
              <text x={labelX} y={labelY} className="venn-set__label" textAnchor="middle">
                {truncate(circle.group.title, 9)}
              </text>
              {circle.hidden > 0 && (
                <text
                  x={labelX}
                  y={labelY + 15}
                  className="venn-set__more"
                  textAnchor="middle"
                >
                  +{circle.hidden}
                </text>
              )}
            </g>
          );
        })}

        {layout.relations.map((relation, index) => {
          const from = layout.positionsById.get(relation.from)!;
          const to = layout.positionsById.get(relation.to)!;
          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          const nx = -(to.y - from.y);
          const ny = to.x - from.x;
          const length = Math.hypot(nx, ny) || 1;
          const bend = 16;
          const controlX = midX + (nx / length) * bend;
          const controlY = midY + (ny / length) * bend;
          return (
            <path
              key={`rel-${index}`}
              className="venn-relation"
              d={`M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`}
            />
          );
        })}

        {layout.circles.flatMap((circle) =>
          circle.positions.map((item) => {
            const node = item.node;
            const selected = node.id === selectedId;
            const color = paletteVariant(paletteTheme, node.mastery, light, 1);
            const due = isDue(node.nextReviewAt, now);
            return (
              <g
                key={node.id}
                className={`venn-node ${selected ? 'is-selected' : ''}`.trim()}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                onClick={() => onSelect(node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
              >
                <title>{`${node.title} · ${node.mastery === 2 ? '已掌握' : node.mastery === 1 ? '有点模糊' : '没记住'}`}</title>
                <circle
                  cx={item.x}
                  cy={item.y}
                  r={selected ? 11 : 7}
                  fill={`rgba(${color.halo}, 0.22)`}
                />
                <circle
                  cx={item.x}
                  cy={item.y}
                  r={selected ? 7.5 : 5}
                  fill={color.core}
                  stroke={selected ? color.mid : 'transparent'}
                  strokeWidth={selected ? 2 : 0}
                />
                {due && (
                  <circle
                    cx={item.x}
                    cy={item.y}
                    r={selected ? 14 : 10}
                    className="venn-node__due"
                  />
                )}
                <text
                  x={item.x}
                  y={item.y + 19}
                  className="venn-node__label"
                  textAnchor="middle"
                >
                  {truncate(node.title, LABEL_MAX)}
                </text>
              </g>
            );
          }),
        )}

        {layout.root && (
          <g
            className={`venn-node venn-node--root ${
              layout.root.id === selectedId ? 'is-selected' : ''
            }`.trim()}
            role="button"
            tabIndex={0}
            aria-pressed={layout.root.id === selectedId}
            onClick={() => onSelect(layout.root!.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(layout.root!.id);
              }
            }}
          >
            <title>{layout.root.title}</title>
            <circle
              cx={CENTER_X}
              cy={CENTER_Y}
              r={layout.root.id === selectedId ? 15 : 11}
              fill={`rgba(${paletteVariant(paletteTheme, layout.root.mastery, light, 1).halo}, 0.24)`}
            />
            <circle
              cx={CENTER_X}
              cy={CENTER_Y}
              r={layout.root.id === selectedId ? 10 : 7}
              fill={paletteVariant(paletteTheme, layout.root.mastery, light, 1).core}
              className="venn-node__core"
            />
            <text x={CENTER_X} y={CENTER_Y + 26} className="venn-node__root-label" textAnchor="middle">
              {truncate(layout.root.title, 12)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
