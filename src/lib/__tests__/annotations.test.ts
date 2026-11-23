import { describe, expect, it } from 'vitest';
import {
  buildSourceSegments,
  normalizeAnnotationRange,
  overlapsAnnotation,
} from '../annotations';
import type { SourceAnnotation } from '../types';

const TEXT = '证明责任是民事证据制度的核心问题，它要回答不利后果由谁承担。';

function annotation(start: number, end: number, note = '批注'): SourceAnnotation {
  return {
    id: `note-${start}-${end}`,
    start,
    end,
    quote: TEXT.slice(start, end),
    note,
    createdAt: 1000,
  };
}

describe('原文批注', () => {
  it('校正划选范围并裁掉首尾空白', () => {
    expect(normalizeAnnotationRange('  甲 乙  ', 0, 9)).toEqual({
      start: 2,
      end: 5,
      quote: '甲 乙',
    });
  });

  it('空白或无效范围被拒绝', () => {
    expect(normalizeAnnotationRange(TEXT, 0, 0)).toBeNull();
    expect(normalizeAnnotationRange(TEXT, 5, 2)).toBeNull();
    expect(normalizeAnnotationRange('   ', 0, 3)).toBeNull();
    expect(normalizeAnnotationRange(TEXT, Number.NaN, 3)).toBeNull();
  });

  it('批注范围不能重叠，但可以首尾相接', () => {
    const existing = [annotation(2, 5)];
    expect(overlapsAnnotation(existing, 4, 6)).toBe(true);
    expect(overlapsAnnotation(existing, 1, 3)).toBe(true);
    expect(overlapsAnnotation(existing, 5, 7)).toBe(false);
    expect(overlapsAnnotation(existing, 0, 2)).toBe(false);
  });

  it('按节点高亮与批注边界切段且不丢字', () => {
    const segments = buildSourceSegments(TEXT, { start: 1, end: 8 }, [annotation(4, 12, '范围批注')]);
    expect(segments.map((item) => item.text).join('')).toBe(TEXT);
    expect(segments[0]).toMatchObject({ start: 0, end: 1, highlighted: false, annotation: null });
    const annotated = segments.filter((item) => item.annotation);
    expect(annotated.map((item) => item.text).join('')).toBe(TEXT.slice(4, 12));
    expect(annotated[0].annotation?.note).toBe('范围批注');
    expect(segments.some((item) => item.highlighted)).toBe(true);
  });

  it('忽略越界批注，没有批注时保持整段渲染', () => {
    const segments = buildSourceSegments(TEXT, null, [annotation(-1, 3), annotation(5, 9999)]);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe(TEXT);
    expect(segments[0].annotation).toBeNull();
  });
});
