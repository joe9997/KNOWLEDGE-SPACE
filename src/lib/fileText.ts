/** 浏览器端文件文本提取：PDF / Word(docx) / PowerPoint(pptx) / 纯文本类 */

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

/** 从文件名得到会话标题：去掉路径与扩展名，保留名称中的点号 */
export function fileNameToTitle(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const withoutExtension = base.replace(/\.[^.]+$/, '').trim();
  return (withoutExtension || base.trim() || '未命名材料').slice(0, 60);
}

/** 给 <input type="file"> 用的 accept，含扩展名与 MIME，避免不同系统下筛选失效 */
export const FILE_ACCEPT = [
  '.pdf',
  '.docx',
  '.doc',
  '.pptx',
  '.pptm',
  '.ppsx',
  '.ppt',
  ...TEXT_EXTENSIONS.map((ext) => `.${ext}`),
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/vnd.ms-powerpoint',
  'text/*',
  'application/json',
].join(',');

export type FileKind =
  | 'image'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'text'
  | 'legacy-word'
  | 'legacy-ppt'
  | 'unknown';

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
    name.endsWith('.pptx') ||
    name.endsWith('.pptm') ||
    name.endsWith('.ppsx') ||
    file.type ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    file.type ===
      'application/vnd.openxmlformats-officedocument.presentationml.slideshow' ||
    file.type === 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'
  ) {
    return 'pptx';
  }
  if (name.endsWith('.ppt') || name.endsWith('.pps')) {
    return 'legacy-ppt';
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

/** 解码 PPTX XML 中的常见实体与数字字符引用 */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (match, code: string) => {
    switch (code.toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        break;
    }
    if (code.startsWith('#')) {
      const hex = code[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(point) && point >= 0 && point <= 0x10ffff) {
        try {
          return String.fromCodePoint(point);
        } catch {
          return match;
        }
      }
    }
    return match;
  });
}

/** 从单页 slide XML 中按段落提取文字，保留换行 */
function slideXmlToText(xml: string): string {
  const token = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/?>|<\/a:p>/g;
  let text = '';
  for (const match of xml.matchAll(token)) {
    if (match[1] !== undefined) {
      text += decodeXmlEntities(match[1]);
    } else {
      text += '\n';
    }
  }
  return text;
}

function slideToMarkedText(paragraphs: string[]): string {
  const lines = paragraphs.map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return '';
  }
  const first = lines[0];
  const isPlaceholder = /^(添加标题|单击此处添加|单击此处编辑|点击此处添加)/.test(first);
  const isTitle =
    !isPlaceholder &&
    first.length >= 4 &&
    first.length <= 40 &&
    !/[。！？；;]$/.test(first);
  if (!isTitle) {
    return lines.join('\n');
  }
  // 用 Markdown 二级标题标记每一页的标题，让本地整理能按页建立章节层级
  return `## ${first}\n${lines.slice(1).join('\n')}`;
}

async function extractPptxText(file: File, maxChars: number): Promise<ExtractedFile> {
  const { unzipSync, strFromU8 } = await import('fflate');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name),
    });
  } catch {
    throw new Error('无法读取这个 PPT 文件，可能已加密或损坏；请另存为 .pptx 后重试');
  }
  const slideNumber = (name: string) => Number(name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
  const slides = Object.keys(entries)
    .sort((a, b) => slideNumber(a) - slideNumber(b))
    .map((name) => {
      const paragraphs = slideXmlToText(strFromU8(entries[name])).split('\n');
      return {
        marked: slideToMarkedText(paragraphs),
        plain: tidy(paragraphs.join('\n')),
      };
    })
    .filter((slide) => slide.marked);
  if (slides.length === 0) {
    throw new Error('PPT 中没有可读取的文字（可能全部是图片或扫描页），请先转为可复制文字的幻灯片。');
  }
  const full = tidy(slides.map((slide) => slide.marked).join('\n\n'));
  return {
    text: full.slice(0, maxChars),
    chars: slides.reduce((sum, slide) => sum + slide.plain.length, 0),
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
    case 'pptx':
      return extractPptxText(file, maxChars);
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
    case 'legacy-ppt':
      throw new Error('暂不支持旧版 .ppt，请在 PowerPoint 中另存为 .pptx 后再上传');
    case 'image':
      throw new Error('这是图片，请用「上传图片」');
    default: {
      const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
      throw new Error(`暂不支持 ${ext ? `.${ext}` : '该'} 格式`);
    }
  }
}
