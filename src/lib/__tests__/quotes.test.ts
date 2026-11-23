import { describe, expect, it } from 'vitest';
import { findQuote, normalizeQuoteText } from '../quotes';

const SOURCE = `# 证据法讲义

证明责任是民事证据制度的核心问题，它要回答在事实真伪不明时由谁承担不利后果。

反证则是不负证明责任的一方为动摇法官心证而提出的证据。`;

describe('findQuote', () => {
  it('逐字命中时返回精确区间', () => {
    const quote = '证明责任是民事证据制度的核心问题，它要回答在事实真伪不明时由谁承担不利后果。';
    const match = findQuote(SOURCE, quote);
    expect(match.matched).toBe(true);
    expect(match.exact).toBe(true);
    expect(SOURCE.slice(match.start, match.end)).toBe(quote);
  });

  it('空白和标点差异时用归一化匹配，区间仍落在原文上', () => {
    const quote = '反证则是不负证明责任的一方 为动摇法官心证而提出的证据';
    const match = findQuote(SOURCE, quote);
    expect(match.matched).toBe(true);
    expect(match.exact).toBe(false);
    expect(SOURCE.slice(match.start, match.end)).toContain('反证则是');
    expect(SOURCE.slice(match.start, match.end)).toContain('提出的证据');
  });

  it('全角与半角差异也能匹配', () => {
    const source = '当事人应当提交原件（原本）。';
    const match = findQuote(source, '当事人应当提交原件(原本).');
    expect(match.matched).toBe(true);
    expect(source.slice(match.start, match.end)).toBe('当事人应当提交原件（原本');
  });

  it('编造的引用必须判定为无出处', () => {
    const match = findQuote(SOURCE, '证明责任完全由法院承担，当事人无需举证。');
    expect(match.matched).toBe(false);
    expect(match.start).toBe(-1);
    expect(match.end).toBe(-1);
  });

  it('空引用不会匹配到位置', () => {
    expect(findQuote(SOURCE, '   ').matched).toBe(false);
  });

  it('归一化映射长度与归一化文本一致', () => {
    const normalized = normalizeQuoteText('A B，C');
    expect(normalized.text).toBe('abc');
    expect(normalized.map).toHaveLength(3);
  });
});
