import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { detectFileKind, extractFileText, fileNameToTitle } from '../fileText';

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function slideXml(paragraphs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>${paragraphs
    .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
}

function makePptx(slides: Record<string, string>): File {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, xml] of Object.entries(slides)) {
    entries[`ppt/slides/${name}`] = strToU8(xml);
  }
  entries['[Content_Types].xml'] = strToU8('<Types/>');
  return new File([zipSync(entries)], 'deck.pptx', { type: PPTX_MIME });
}

describe('文件名转标题', () => {
  it('去掉路径与最后一个扩展名，保留名称中的点号', () => {
    expect(fileNameToTitle('证据法讲义·证明责任.pptx')).toBe('证据法讲义·证明责任');
    expect(fileNameToTitle('C:\\notes\\民法 v1.2 讲义.md')).toBe('民法 v1.2 讲义');
    expect(fileNameToTitle('lecture.final.pdf')).toBe('lecture.final');
    expect(fileNameToTitle('说明')).toBe('说明');
  });
});

describe('PPTX 文本提取', () => {
  it('识别 pptx 与旧版 ppt', () => {
    expect(detectFileKind(new File([], 'deck.pptx', { type: PPTX_MIME }))).toBe('pptx');
    expect(detectFileKind(new File([], 'deck.ppt', { type: 'application/vnd.ms-powerpoint' }))).toBe(
      'legacy-ppt',
    );
  });

  it('按幻灯片序号读取文字并解码实体', async () => {
    const file = makePptx({
      'slide10.xml': slideXml(['经验法则 &amp; 证明妨碍']),
      'slide2.xml': slideXml(['自由心证', '第二段']),
    });
    const result = await extractFileText(file, 10_000);
    expect(result.text).toContain('自由心证\n第二段');
    expect(result.text).toContain('经验法则 & 证明妨碍');
    expect(result.text.indexOf('自由心证')).toBeLessThan(result.text.indexOf('经验法则'));
    expect(result.truncated).toBe(false);
  });

  it('按上限截断并标记 truncated', async () => {
    const file = makePptx({ 'slide1.xml': slideXml(['一二三四五六七八九十']) });
    const result = await extractFileText(file, 4);
    expect(result.text).toBe('## 一');
    expect(result.chars).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('没有可读文字时给出明确错误', async () => {
    const file = makePptx({});
    await expect(extractFileText(file, 1000)).rejects.toThrow('没有可读取的文字');
  });

  it('拒绝旧版 ppt 并提示另存为 pptx', async () => {
    const file = new File([], 'old.ppt', { type: 'application/vnd.ms-powerpoint' });
    await expect(extractFileText(file, 1000)).rejects.toThrow('另存为 .pptx');
  });
});
