import type { SourceAnnotation } from './types';

export interface AnnotationRange {
  start: number;
  end: number;
  quote: string;
}

export interface SourceSegment {
  start: number;
  end: number;
  text: string;
  /** 该段是否落在当前节点的原文引用区间内 */
  highlighted: boolean;
  /** 覆盖该段的批注；批注互不重叠，最多一个 */
  annotation: SourceAnnotation | null;
}

function isValidRange(textLength: number, start: number, end: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= textLength &&
    end > start
  );
}

/** 校正用户划选的范围：裁掉首尾空白，越界直接拒绝 */
export function normalizeAnnotationRange(
  text: string,
  start: number,
  end: number,
): AnnotationRange | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  let from = Math.max(0, Math.trunc(start));
  let to = Math.min(text.length, Math.trunc(end));
  while (from < to && /\s/.test(text[from])) {
    from += 1;
  }
  while (to > from && /\s/.test(text[to - 1])) {
    to -= 1;
  }
  if (to <= from) {
    return null;
  }
  const quote = text.slice(from, to);
  if (!quote.trim()) {
    return null;
  }
  return { start: from, end: to, quote };
}

export function overlapsAnnotation(
  annotations: SourceAnnotation[],
  start: number,
  end: number,
): boolean {
  return annotations.some((item) => start < item.end && end > item.start);
}

/** 把原文按「节点高亮边界 + 批注边界」切成互不重叠的小段，用于渲染 */
export function buildSourceSegments(
  text: string,
  highlight: { start: number; end: number } | null,
  annotations: SourceAnnotation[],
): SourceSegment[] {
  if (!text) {
    return [];
  }
  const validAnnotations = annotations
    .filter((item) => isValidRange(text.length, item.start, item.end))
    .sort((a, b) => a.start - b.start);
  const validHighlight =
    highlight && isValidRange(text.length, highlight.start, highlight.end) ? highlight : null;

  const points = new Set<number>([0, text.length]);
  if (validHighlight) {
    points.add(validHighlight.start);
    points.add(validHighlight.end);
  }
  validAnnotations.forEach((item) => {
    points.add(item.start);
    points.add(item.end);
  });

  const sorted = [...points].sort((a, b) => a - b);
  const segments: SourceSegment[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index];
    const end = sorted[index + 1];
    if (end <= start) {
      continue;
    }
    segments.push({
      start,
      end,
      text: text.slice(start, end),
      highlighted: Boolean(
        validHighlight && start >= validHighlight.start && end <= validHighlight.end,
      ),
      annotation: validAnnotations.find((item) => start >= item.start && end <= item.end) ?? null,
    });
  }
  return segments;
}
