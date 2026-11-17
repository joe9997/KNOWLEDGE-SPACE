import { describe, expect, it } from 'vitest';
import { chunkText, parseExtraction, validateApiConfig } from '../llm';

const TEXT = '甲'.repeat(2000);

describe('分块与模型输出解析', () => {
  it('按 800 字、100 字重叠分块', () => {
    const chunks = chunkText(TEXT, 800, 100);
    expect(chunks[0].text).toHaveLength(800);
    expect(chunks[1].start).toBe(700);
    expect(chunks[2].start).toBe(1400);
    expect(chunks[chunks.length - 1].start + chunks[chunks.length - 1].text.length).toBe(
      TEXT.length,
    );
    chunks.forEach((chunk) => {
      expect(chunk.text.length).toBeLessThanOrEqual(800);
    });
  });

  it('逐行解析 Markdown，坏行跳过但不丢整棵树', () => {
    const content = `# 证明责任
## 证明对象 :: 证明对象是当事人需要运用证据加以证明的事实范围。 :: 哪些事实需要证明？
这一行缺少分隔符，应该跳过
### 本证 :: 本证是负有证明责任的一方为证明其主张成立而提出的证据。 :: 本证由谁提出？
## 无出处节点 :: - :: 它是什么？
`;
    const nodes = parseExtraction(content);
    expect(nodes).toHaveLength(4);
    expect(nodes[0]).toMatchObject({ title: '证明责任', level: 0, quote: '证明责任' });
    expect(nodes[1].level).toBe(1);
    expect(nodes[2].level).toBe(2);
    expect(nodes[3].quote).toBe('');
  });

  it('去掉模型可能返回的代码块包裹', () => {
    const nodes = parseExtraction('```markdown\n# 主题 :: 原句。 :: 问句？\n```');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].title).toBe('主题');
  });
});

describe('API 配置校验', () => {
  it('缺少 Key、URL 或模型名时报错', () => {
    const result = validateApiConfig({
      provider: 'custom',
      apiKey: ' ',
      baseUrl: 'ftp://example.com',
      model: '',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.apiKey).toBeTruthy();
    expect(result.errors.baseUrl).toBeTruthy();
    expect(result.errors.model).toBeTruthy();
  });

  it('合法配置通过校验', () => {
    const result = validateApiConfig({
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1/',
      model: 'gpt-4o-mini',
    });
    expect(result.ok).toBe(true);
  });
});
