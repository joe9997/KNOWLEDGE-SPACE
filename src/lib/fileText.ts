/** 浏览器端文件文本提取：PDF / Word(docx) / 纯文本类 */

const TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'mdx',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'log',
  'yml',
  'yaml',
  'xml',
  'html',
  'htm',
  'srt',
  'ini',
  'conf',
  'tex',
];

/** 给 <input type="file"> 用的 accept，含扩展名与 MIME，避免不同系统下筛选失效 */
export const FILE_ACCEPT = [
  '.pdf',
  '.docx',
  '.doc',
  ...TEXT_EXTENSIONS.map((ext) => `.${ext}`),
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/*',
  'application/json',
].join(',');

export type FileKind = 'image' | 'pdf' | 'docx' | 'text' | 'legacy-word' | 'unknown';

export interface ExtractedFile {
  text: string;
  /** 原文总长度（超出 maxChars 时为已读取部分长度） */
  chars: number;
  truncated: boolean;
}

export function detectFileKind(file: File): FileKind {
  if (file.type.startsWith('image/')) {
    return 'image';
  }
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    return 'pdf';
  }
  if (
    name.endsWith('.docx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  if (name.endsWith('.doc')) {
    return 'legacy-word';
  }
  if (
    file.type.startsWith('text/') ||
    TEXT_EXTENSIONS.some((ext) => name.endsWith(`.${ext}`))
  ) {
    return 'text';
  }
  return 'unknown';
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function decodeText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buffer);
  if (text.includes('\uFFFD')) {
    try {
      const fallback = new TextDecoder('gb18030').decode(buffer);
      const bad = (value: string) => (value.match(/\uFFFD/g) ?? []).length;
      if (bad(fallback) < bad(text)) {
        text = fallback;
      }
    } catch {
      // 浏览器不支持 gb18030 时保留 UTF-8 结果
    }
  }
  if (/\.(html?|xml)$/i.test(file.name)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"');
  }
  return tidy(text);
}

async function extractPdfText(file: File, maxChars: number): Promise<ExtractedFile> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const pdf = await task.promise;
  const pages: string[] = [];
  let chars = 0;
  try {
    for (let index = 1; index <= pdf.numPages; index += 1) {
      if (chars >= maxChars) {
        break;
      }
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!('str' in item)) {
          continue;
        }
        pageText += item.str;
        pageText += item.hasEOL ? '\n' : ' ';
      }
      const cleaned = pageText.replace(/[ \t]+\n/g, '\n').trim();
      if (cleaned) {
        pages.push(cleaned);
        chars += cleaned.length;
      }
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  const full = tidy(pages.join('\n\n'));
  return {
    text: full.slice(0, maxChars),
    chars: full.length,
    truncated: full.length > maxChars,
  };
}

async function extractDocxText(file: File, maxChars: number): Promise<ExtractedFile> {
  type MammothLike = {
    extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
  };
  const mod = (await import('mammoth')) as unknown as MammothLike & { default?: MammothLike };
  const mammoth = mod.default ?? mod;
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  const full = tidy(result.value ?? '');
  return {
    text: full.slice(0, maxChars),
    chars: full.length,
    truncated: full.length > maxChars,
  };
}

/**
 * 读取文件中的文字。不支持的类型会抛出可直接展示的错误。
 * @param maxChars 最多返回多少字，超出部分截断
 */
export async function extractFileText(file: File, maxChars: number): Promise<ExtractedFile> {
  const kind = detectFileKind(file);
  switch (kind) {
    case 'pdf':
      return extractPdfText(file, maxChars);
    case 'docx':
      return extractDocxText(file, maxChars);
    case 'text': {
      const full = await decodeText(file);
      return {
        text: full.slice(0, maxChars),
        chars: full.length,
        truncated: full.length > maxChars,
      };
    }
    case 'legacy-word':
      throw new Error('暂不支持旧版 .doc，请在 Word 中另存为 .docx 或 PDF 后再上传');
    case 'image':
      throw new Error('这是图片，请用「上传图片」');
    default: {
      const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
      throw new Error(`暂不支持 ${ext ? `.${ext}` : '该'} 格式`);
    }
  }
}
