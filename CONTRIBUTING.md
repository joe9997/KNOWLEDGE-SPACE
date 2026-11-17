# 协作指南 · KNOWLEDGE-SPACE

6 人共同维护这一个前端仓库，仓库是 **Private**，只有下面列出的 6 个 GitHub 账号能看到。
约定不是形式主义——目的是**每个人每天都能合进 main，且不互相踩脚**。

---

## 0. 一次性准备（每人做一次）

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（建议 20 LTS / 22） | 项目用 Vite 6 + React 19 |
| npm | 随 Node 自带（≥ 10） | 仓库只有 `package-lock.json`，**用 npm，不要用 yarn** |
| Git | 任意新版 | Windows 安装时勾选 “Git from the command line” |

> 想用 pnpm 也可以，但整个团队必须统一——现在备案的是 npm。换包管理器要一次性全换，
> 否则仓库里会同时出现两份锁文件，CI 必红。

### 配 Git 身份

```bash
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱"   # 必须是 GitHub 账号绑定的邮箱，否则贡献不计入你的头像
```

保密邮箱：GitHub → Settings → Emails 勾 *Keep my email addresses private*，
然后这里填 `12345678+用户名@users.noreply.github.com`。

### 拉代码

```bash
git clone https://github.com/joe9997/KNOWLEDGE-SPACE.git
cd KNOWLEDGE-SPACE
npm install
npm run dev        # http://127.0.0.1:5173
```

先确认 `npm run test` 全绿、`npm run build` 成功，再动手改。

---

## 1. 分支模型：main 只读，一切走 PR

```
main          ← 永远可构建、可部署。受保护分支，禁止直接 push
 ├─ feat/…    ← 新功能
 ├─ fix/…     ← bug 修复
 ├─ docs/…    ← 文档 / 截图
 └─ chore/…   ← 依赖、配置、CI
```

- **main 上的每一次提交都必须来自一个合并的 PR。**
- 分支名小写短横线：`feat/graph-wheel-zoom`、`fix/quiz-color-sync`。
- 一个分支只做一件事。做一半也要开 PR（标 `Draft`），让队友早点看到方向。

### 每天开工

```bash
git switch main
git pull --rebase origin main      # 用 rebase，别产生无意义的 merge commit
git switch -c feat/your-thing
```

### 提交

```bash
git add -p                         # 分块暂存，别把无关改动塞进一个提交
git commit -m "feat(graph): 支持滚轮缩放并记住比例"
git push -u origin feat/your-thing
```

| 前缀 | 用途 | 例 |
| --- | --- | --- |
| `feat` | 新功能 | `feat(quiz): 自评后立即刷新待复习数` |
| `fix` | 修 bug | `fix(llm): 模型列表为空时不再白屏` |
| `refactor` | 不改行为的重构 | `refactor(styles): 玻璃材质变量收进 tokens.css` |
| `docs` | 文档 / 截图 | `docs: 补充移动端截图` |
| `test` | 测试 | `test(graph): 补环形布局用例` |
| `chore` | 依赖 / 配置 / CI | `chore: 升级 vite` |

### 开 PR 并合并

1. 发起 PR，目标 `main`，按模板填**改了什么 / 怎么验证 / 截图**。
2. CI 必须绿（`.github/workflows/ci.yml`：`npm test` + `npm run build`）。
3. **至少 1 人 Approve**；改到公共模块要 2 人（见 §3）。
4. 合并方式统一 **Squash and merge**——一个 PR 在 main 上只留一个干净提交。
5. 合并后删远端分支；本地 `git switch main && git pull --rebase` 再开下一个。

---

## 2. 仓库设置（管理员一次性点完）

Settings：

1. **General → Danger Zone**：确认 **Private**（已经设好，别手滑改 public）。
2. **Branches → Add branch protection rule**，分支名 `main`：
   - ✅ Require a pull request before merging
   - ✅ Require approvals = **1**
   - ✅ Dismiss stale approvals when new commits are pushed
   - ✅ Require status checks to pass → 选 `check`
   - ✅ Require conversation resolution before merging
   - ✅ Do not allow bypassing the above settings（含管理员）
   - ❌ 不勾 Allow force pushes / Allow deletions
3. **General → Pull Requests**：只留 **Allow squash merging**。
4. **Collaborators and teams**：只有 6 个账号，权限一律 **Write**。管理员 1–2 人。
   - 有人离组：立刻在 Collaborators 里 Remove，历史提交不受影响。
5. **Actions → General → Workflow permissions**：选 *Read and write*（Pages 部署要）。
6. **Pages → Source**：选 **GitHub Actions**。

> Private 仓库的 Pages 需要 GitHub Pro / Team 套餐；个人免费账号在 private 仓库上
> 开启 Pages 会提示升级。没有套餐就把 Pages 当可选——本地 `npm run dev` 一样能看效果。

---

## 3. 文件分工：按目录认领，减少冲突

冲突的根源是两个人改同一个文件。按现有结构切：

| 角色 | 认领目录 / 文件 |
| --- | --- |
| **知识图谱** | `src/components/graph/`（`KnowledgeGraph.tsx`、`graphLayout.ts`）、`src/pages/GraphPage.tsx` |
| **录入与溯源** | `src/components/intake/`、`src/components/source/`、`src/pages/NewSessionPage.tsx`、`src/lib/quotes.ts` |
| **自测与复习** | `src/components/quiz/`、`src/components/TimeTravel.tsx`、`src/lib/review.ts` |
| **页面与状态** | `src/pages/{HomePage,ApiConfigPage}.tsx`、`src/state/AppStore.tsx`、`src/components/layout/` |
| **视觉与动效** | `src/components/background/`、`src/components/ui/`、`src/theme/`、`src/styles/{tokens,glass}.css`、`src/lib/starfield.ts` |
| **模型与数据** | `src/lib/{llm,localExtract,storage,exportMarkdown,id}.ts`、`src/lib/useMediaQuery.ts`、`src/data/demo.ts`、`src/lib/__tests__/` |

【公共文件】改之前先在 Issue / 群里说一声，PR 要 **2 人 Approve**：

- `src/lib/types.ts` —— **数据契约**。要加字段：先单独提一个只改 types.ts 的 PR 并合并，其他人再基于它写。
- `src/App.tsx`、`src/main.tsx` —— 路由与入口
- `src/styles/app.css` —— 47 KB 的大文件，一次只由一个人改
- `index.html`、`package.json`、`package-lock.json`、`vite.config.ts`、`tsconfig.json`

---

## 4. 评审清单（Reviewer 照这个看）

- [ ] 改动只做了 PR 标题说的事，没夹带无关重构
- [ ] `npm test` 和 `npm run build` 本地跑过
- [ ] 新逻辑配了测试；没验证过的“看起来对”不算
- [ ] 深色 / 浅色两套主题都看过；≤ 480px 宽度没崩
- [ ] 没提交 `node_modules`、`dist`、`.trae-html-share-packages`、`.screenshots`、`.env`、API Key
- [ ] 命名与现有风格一致（组件 PascalCase、工具 camelCase、CSS kebab-case）
- [ ] 没有把密钥写进代码（`llm.ts` 的 key 只从 `sessionStorage` 读）

---

## 5. 常见事故与处理

### 冲突

```bash
git switch main && git pull --rebase origin main
git switch feat/your-thing
git rebase main
# 解决冲突 → git add <文件> → git rebase --continue
git push --force-with-lease        # rebase 后要强推，只对自己的分支用
```

main 永远不强推。

### `package-lock.json` 冲突

别手改。由合并者在 main 上重建：

```bash
git switch main && git pull
npm install
git add package-lock.json && git commit -m "chore: 重新生成锁文件" && git push
```

其他人 `git checkout main -- package-lock.json && npm install` 同步。

### 满屏 “LF will be replaced by CRLF”

`.gitattributes` 已统一成 LF。若仍有：

```bash
git add --renormalize .
git commit -m "chore: 统一换行符为 LF"
```

### 端口 5173 被占

```bash
npm run dev -- --port 5174
```

### 提交里混进了不该提交的东西

```bash
git rm -r --cached node_modules     # 从索引移除，本地文件保留
git commit -m "chore: 移除误提交的依赖目录"
```

并把路径写进 `.gitignore`。

---

## 6. 本地检查

```bash
npm run test        # vitest
npm run test:watch  # 监听模式
npm run build       # tsc --noEmit + vite build
npm run preview     # 预览构建产物
```

---

## 7. 发布

推 main 后 `.github/workflows/deploy-pages.yml` 会构建并发布（需要 Pages 可用）。
`vite.config.ts` 里 `base: './'`，所以子路径部署和本地 `npm run dev` 都不用改配置。

看某个 PR 的效果：本地 checkout 那个分支跑 `npm run dev`，不要为此合进 main。
