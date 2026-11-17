# 回源 · KNOWLEDGE SPACE

把一段讲义变成一片彼此连接的知识星空。每个节点都能回到原文那一句，按掌握程度自测，并按间隔复习只推今天该记的内容。

本项目是 React 19 + TypeScript + Vite 前端，加一个可选的 Node 后端（`server/`，Express）。后端负责托管模型 Key 并代理 AI 调用；不启动后端时，前端仍可独立运行，文档与复习进度照旧保存在浏览器本地。API Key 在服务端模式下只存在于 `.env`，在自带 Key 模式下只存在于当前标签页的 `sessionStorage`。

## 快速开始

需要 Node.js 20 及以上。

```bash
npm install
npm run dev
```

终端会打印实际访问地址（若 5173 被占用，Vite 会自动使用下一个可用端口）。

### 启用服务端 AI（可选，推荐）

后端默认监听 `127.0.0.1:3001`，Vite 已把 `/api` 代理过去。

```bash
copy .env.example .env   # macOS / Linux 用 cp
# 编辑 .env：填写 LLM_API_KEY、LLM_BASE_URL、LLM_MODEL
npm run dev:all          # 同时启动前端（5173）与后端（3001）
```

只想起后端：`npm run dev:server`；生产构建后单进程运行：`npm run build && npm start`。

生产构建与本地预览：

```bash
npm run build
npm run preview
```

运行单元测试：

```bash
npm test
```

## 不装 Node 也能看：双击 `KNOWLEDGE-SPACE.html`

仓库根目录的 **`KNOWLEDGE-SPACE.html`**（约 880 KB）是整个网页的**单文件离线版**：
JS、CSS、字体、背景图全部内联在这一个文件里，没有任何外部请求。

- **双击就能打开**，不需要 Node、不需要联网、不需要起服务器。
- 深色 / 浅色主题、知识网络、自测复习、Markdown 导出、API 配置全部可用；
  数据照常存在浏览器的 `localStorage` / `sessionStorage` 里。
- 发微信、发邮件、拷到 U 盘给同学，都是这一个文件。

需要重新生成时（改了 UI 之后）：

```bash
npm run build:single
```

> 它会先跑一次 IIFE 格式的构建，再把产物内联成单文件。
> 直接提交 Vite 产出的 `dist/index.html` 是不行的——那里用的是
> `<script type="module">`，`file://` 协议下浏览器会按 CORS 规则拒绝加载，双击只会白屏。

最新版本也可以从 GitHub Actions 的 `standalone-html` 产物里直接下载，不必 clone 仓库。

## 团队协作（6 人）

仓库是 **Private**，只有项目组的 6 个 GitHub 账号能访问。

`main` 是受保护分支，**任何人都不直接 push**，一切改动走分支 + PR：

```bash
git switch main && git pull --rebase
git switch -c feat/your-thing
# 改代码
npm test && npm run build
git add -p && git commit -m "feat(graph): 支持滚轮缩放"
git push -u origin feat/your-thing
```

GitHub 上开 PR → CI 绿 → 1 人 Approve → Squash merge（自动删分支）。

完整的约定（提交规范、按目录分工、公共文件归属、冲突与锁文件处理、评审清单）
见 [CONTRIBUTING.md](CONTRIBUTING.md)。**首次加入请先读它。**

| 自动化 | 位置 |
| --- | --- |
| CI：`npm test` + `npm run build` | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| 发布：手动触发部署 Pages | [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) |
| PR / Issue 模板、CODEOWNERS | `.github/` |

## 已实现

- **首页**：夜间环形星轨、日间高山日光照片背景；悬浮玻璃侧栏、继续探索与今日待复习卡片、演示时间切换；主标题逐字模糊浮现。
- **新建材料**：从首页主按钮或侧栏「新会话」进入独立的新建会话页；粘贴文本或拖入 / 选择 `.txt`、`.md`，上限 20,000 字；本地规则整理不调用 AI；配置 API 后可真实调用模型抽取。
- **知识网络**：React 发光节点 + SVG 曲线连线，核心居中；支持节点拖动、画布平移、缩放、重置、全屏与 Markdown 导出。
- **原文溯源**：点击节点打开右侧玻璃面板，滚动并高亮逐字匹配的原句；匹配失败时标记「无出处」、置灰且不高亮。
- **自测**：先看问题 → 查看原文答案 → 三档自评（还没记住 / 有点模糊 / 已经掌握）。自评即时更新节点颜色、到期数量与下一次复习时间。
- **间隔复习**：简化 SM-2（PRD 第 11 节），支持「今天 / 三天后 / 七天后」演示时间旅行；今日列表优先展示前 3 个到期节点，并支持逐个继续复习。
- **两套主题**：深色深海军蓝星轨、浅色高山白昼照片 + 珍珠白玻璃，独立文字 / 边框 / 阴影 / 节点配色；主题写入 `localStorage`，默认深色。
- **响应式**：手机端侧栏为抽屉，关闭时 `inert` + 隐藏，既不遮挡也不进入焦点顺序；无横向溢出。
- **弹窗可访问性**：关闭按钮、Escape、遮罩关闭、Tab 焦点约束与关闭后焦点归还。

## 数据与隐私

| 数据 | 存储位置 | 生命周期 |
| --- | --- | --- |
| 文档、节点、复习进度 | `localStorage`（`huiyuan.docs.v1` 等） | 留在当前浏览器 |
| 当前会话 | `localStorage` | 重新打开仍保留 |
| 主题 | `localStorage`（`huiyuan.theme`） | 重新打开仍保留 |
| API 配置与 Key | `sessionStorage`（`huiyuan.api.session.v1`） | 仅当前标签页，关闭即清除 |
| 服务端模型 Key | `.env`（仅后端进程读取） | 不返回浏览器，不写入日志 |
| 演示时间偏移 | 内存状态 | 刷新后回到今天 |

- 自带 Key 模式的 API Key **不会**写入源码或 `localStorage`，只留在当前标签页的 `sessionStorage`；服务端模式的 Key 只在 `.env` 中，由后端进程读取。
- 服务端模式：材料会发送到本地后端，再由后端转发到 `.env` 配置的模型服务；自带 Key 模式：材料由浏览器**直接发送到你填写的模型服务**。使用者需自行确认该服务的隐私政策。
- 示例材料「证据法讲义 · 证明责任」在侧栏、页面头部与导出内容中均标注为「体验材料」。

## 后端（服务端托管 AI）

`server/` 是一个最小的 Express 服务，目前只做模型调用中转（不含账号与数据库）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回 AI 是否已配置 |
| GET | `/api/ai/status` | 前端读取服务端模型状态（不返回 Key） |
| POST | `/api/ai/test` | 用服务端配置请求 `/models` 测试连接 |
| POST | `/api/ai/extract` | 接收单个文本块（≤ 4000 字），调用模型并返回解析后的节点 |

环境变量（`.env`，参考 `.env.example`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容服务地址 |
| `LLM_API_KEY` | 空 | 为空时服务端 AI 不可用 |
| `LLM_MODEL` | `deepseek-chat` | 模型名称 |
| `PORT` | `3001` | 后端端口 |
| `LLM_TIMEOUT_MS` | `90000` | 单块抽取超时 |

- 服务只监听 `127.0.0.1`，Key 不会返回给浏览器，也不会写入日志。
- 分块、进度与跨块去重仍由前端完成（每块一次请求），「已处理 x/n 块」照常实时显示。
- 未启动后端或未配置 Key 时，前端自动回退到「自带 Key 浏览器直连」模式。
- 同一份抽取规则（Prompt、解析、合并、引用校验）在 `src/lib/extractCore.ts` 共享，前后端不会各写一套。

## API 接入

在「接入 API」页填写：

- 模型服务（OpenAI 兼容 / DeepSeek / 自定义兼容服务）
- API Key
- 接口 Base URL（如 `https://api.openai.com/v1`）
- 模型名称（如 `gpt-4o-mini`、`deepseek-chat`）

行为：

- **服务端优先**：只要 `/api/ai/status` 返回已配置，AI 整理就走本地后端，页面上方会显示「服务端 AI · 已启用」并提供独立的测试连接按钮。
- **测试连接**：`GET {baseUrl}/models`。只有 HTTP 200 且返回 JSON 模型列表 `data[]` 才算成功；否则展示真实 HTTP 状态、响应片段、CORS / 网络错误或「返回 200 但不是 JSON」。不会伪造成功。
- **生成节点**：`POST {baseUrl}/chat/completions`，按 800 字 / 100 字重叠分块，逐块调用并展示 `已处理 x/n 块` 进度。
- 浏览器直连受目标服务的 CORS 策略限制；失败时页面会显示实际错误，而不是降级成假数据。

## 抽取与溯源

### 本地规则整理（不调用 AI）

- 有 Markdown 标题：标题成为节点，标题下第一句完整原句作为引用；标题较少时用正文完整句子补足节点。
- 无标题：按完整句子抽取，句子即原文引用，标题取句首短语。
- 所有节点初始为「待复习」，引用经过下文的逐字校验。

### AI 抽取

Prompt 与输出格式遵循 PRD：模型输出 `## 标题 :: 原句引用 :: 回忆问句` 的 Markdown 大纲，而不是 JSON；解析器逐行容错，坏行只跳过该行。跨块结果按标题去重，仅保留一个中心节点。

### 引用校验（宁可不标，也不标错）

1. 原文逐字命中（`indexOf`）优先；
2. 失败后做归一化匹配（忽略空白、全半角差异、标点），并维护「归一化位置 → 原文字符位置」的映射，返回的高亮区间始终落在原文上；
3. 仍失败则判定为**无出处**：面板显示说明、不高亮，节点默认置灰，导出笔记中也不展示伪造引用。

> PRD 中第三级兜底（句子切分 + pgvector 相似度 ≥ 0.75）依赖后端向量检索，本项目未实现；前端只采用前两级，失败即标记无出处。

## 复习算法

```ts
grade 0 → mastery=0, goodStreak=0, +1 天
grade 1 → mastery=1, goodStreak=0, +2 天
grade 2 → mastery=2, goodStreak++, +round(3 * 1.6 ** goodStreak) 天
```

- 到期节点显示为粉红「待复习」，未到期的模糊节点为暖黄，已掌握为薄荷绿。
- 示例材料初始恰好有 3 个到期节点；时间旅行切换后会变化。
- 时间旅行只改变前端查询与复习计算的「现在」，用于演示，不修改系统时间。

## 性能设计

### 玻璃材质

- 主按钮才使用 `liquid-glass-react` 的真实折射（首页主按钮、新会话、保存配置、AI 整理）。
- 为避免库内逐像素鼠标跟随，向库传入静态 `globalMousePos` / `mouseOffset`，并设置 `elasticity={0}`，不会在鼠标移动时持续触发 React 更新与布局测量。
- 库内部的隐藏 SVG 与装饰层统一 `pointer-events: none`；点击由最上层真实 `<button>` 负责，键盘与焦点可见性不受影响。
- 大面板（侧栏、卡片、弹窗、原文面板、画布）各自只有一层适度的 `backdrop-filter`；输入框、小图标按钮、节点、工具栏不再叠加背景采样。
- 浅色主题的液态玻璃按钮在折射边缘之上覆盖一层珍珠白渐变，保证按钮内部与文字清晰明亮，同时保留边缘折射；日间首页主按钮使用深色玻璃，在明亮山景上保持视觉锚点。

### 背景与动效

- 夜间一次性绘制 **2,300** 条环形短星轨到 Canvas，只在主题变化或窗口尺寸变化时重绘。
- 夜间动画完全交给 CSS：`transform: rotate(-3deg → 3deg)`、**6 秒**往返、`alternate`；桌面 `steps(240, end)`，手机 `steps(144, end)`，比最初版本更快。
- 日间改用高山日光照片（`public/assets/day-alpine.jpg`）与少量白色光点 / 雪尘，并叠加 Canvas 飘雪（约 50–150 片，带横向风摆），不再绘制星轨；卡片与侧栏保持珍珠白玻璃质感，边框使用更明亮的白色。
- 飘雪用两层半透明圆模拟柔边，避免逐帧 `shadowBlur`；DPR 上限 1.5、最大边长 2,200px，深色主题下不挂载，页面隐藏或减少动态效果时停止。
- 首页主标题「让知识，有迹可循。」按字符拆分，逐字执行模糊 + 上移 + 淡入动画；开启「减少动态效果」时直接显示完整标题。
- Canvas 预留 8% 边缘、限制 DPR ≤ 1.5、最大边长 2,400px，避免旋转露底和显存浪费。
- `visibilitychange` 暂停星轨与飘雪动画；`prefers-reduced-motion` 直接停止；窗口 resize 经防抖 + 单帧调度合并为一次重绘。

### 知识网络拖动

- 拖动中使用 `ref` + `requestAnimationFrame` 直接更新节点 `transform` 与相连 SVG 路径，每帧最多一次，不触发 React 重渲染。
- `pointerup` / `pointercancel` / `lostpointercapture` 都会结束拖动，并在结束时才把位置同步到 React 状态。
- 平移同样使用 rAF + ref，缩放通过按钮或 `Ctrl / ⌘ + 滚轮`。

## 目录结构

```text
server/
  index.ts                              # Express 路由、静态托管、错误处理
  ai.ts                                 # 服务端模型调用与连接测试
  config.ts                             # .env 读取与配置校验
src/
  components/
    background/StarfieldBackground.tsx  # 夜间星轨 + 日间山景与光点
    background/Snowfall.tsx             # 日间 Canvas 飘雪
    graph/KnowledgeGraph.tsx            # 节点拖动 / 缩放 / 全屏 / 导出
    graph/graphLayout.ts                # 环形布局、连线路径
    intake/NewSessionForm.tsx           # 粘贴 / 文件 / 本地或 AI 整理
    layout/Sidebar.tsx, TopBar.tsx      # 侧栏抽屉、顶栏
    quiz/QuizModal.tsx                  # 问题 → 答案 → 三档自评
    source/SourcePanel.tsx              # 原文滚动与高亮
    ui/LiquidButton.tsx, ui/Modal.tsx   # 液态玻璃按钮、焦点约束弹窗
  data/demo.ts                          # 示例材料（体验材料）
  lib/
    quotes.ts                           # 逐字 / 归一化引用匹配
    review.ts                           # 简化 SM-2
    localExtract.ts                     # 本地规则整理
    extractCore.ts                      # 前后端共享：分块、Prompt、解析、合并
    llm.ts                              # 自带 Key：API 校验与浏览器直连
    serverAi.ts                         # 服务端模式：状态、测试连接、逐块抽取
    starfield.ts                        # 绘制、尺寸限制、重绘调度
    storage.ts, exportMarkdown.ts       # 本地存储、Markdown 导出
  pages/                                # 首页 / 新建会话 / 知识网络 / 接入 API
  state/AppStore.tsx                    # 文档、复习、API 配置状态
  styles/                               # 主题令牌、玻璃材质、页面样式
  theme/ThemeProvider.tsx
```

## 验证情况

`npm test`：5 个测试文件、31 个用例，覆盖引用匹配（逐字 / 归一化 / 伪造引用 / 空引用）、复习算法与演示到期数、本地抽取层级、LLM 分块与容错解析、API 配置校验、星轨数量 / 确定性 / 尺寸上限、暂停条件与 resize 重绘调度。

同时在本地 Edge 无头浏览器做了桌面（1440×900）与手机（390×844）检查，包括：

- 深浅主题、刷新保留主题、手机图标切换；
- 星轨 `transform` 在 1.2 秒内确实变化，夜间动画周期为 6 秒，`steps(240)` / `steps(144)` 生效；
- 日间切换为高山照片背景，标题字符在首帧处于半透明 / 位移动画中，最终完整显示；
- 日间飘雪 Canvas 帧间内容持续变化，所有元素边框切换为白色系；
- 液态玻璃渲染、按钮点击不被内部 SVG 拦截；
- `.md` 导入、20,001 字拒绝、本地整理生成多节点；
- 节点拖动、缩放、原文高亮、自测三档、导出下载、时间旅行数量变化；
- 弹窗 Tab 焦点约束、Escape 关闭与焦点归还；
- API 配置只进 `sessionStorage`、刷新可恢复、`localStorage` 不含 Key；
- 测试连接真实失败状态，以及用拦截的 OpenAI 兼容响应验证成功状态与「伪造引用 → 无出处」；
- 手机端无横向溢出、关闭的抽屉无法获得键盘焦点、原文面板与图例可用；
- `prefers-reduced-motion` 下星轨动画停止。

未使用真实 API Key 进行外部模型调用验证；浏览器直连的成功路径通过拦截的 OpenAI 兼容响应做了端到端验证。后端新增接口（`/api/health`、`/api/ai/status`、`/api/ai/test`、`/api/ai/extract`）用本地 mock 的 OpenAI 兼容服务验证了完整链路：API 页显示「已启用 · mock-chat」、测试连接成功、AI 整理生成可溯源节点。

## 素材说明

- 日间背景照片来自 Unsplash 免费图库，已下载到 `public/assets/day-alpine.jpg`，运行时不依赖外部图片服务。
- 图标来自 `lucide-react`；液态玻璃效果来自 `liquid-glass-react`。

## 后端边界

已实现：服务端模型 Key 托管、连接测试、单块抽取中转、本地静态托管。

仍未实现：

- 账号、登录、多设备同步；
- 服务端持久化（Postgres / Supabase）与文档上传；
- 服务端异步抽取任务、重试队列与整篇进度接口；
- pgvector 句子切分与相似度兜底（≥ 0.75）；
- 限流与配额、多租户 Key 管理；
- PDF / 图片 OCR、多人协作、分享广场；
- 部署与公网访问（后端默认只监听 `127.0.0.1`）。
