# 从这里开始 · 新版三人四子棋

## 直接在电脑预览

1. 把完整 ZIP 解压到一个**新目录**，不要直接覆盖正在运行的旧项目数据库。
2. 电脑使用 Node.js 22.13 或以上版本，推荐你现有的 Node.js 24。
3. 双击项目根目录 `start-ui-preview.bat`。
4. 浏览器打开 `http://127.0.0.1:5173`。启动器会在 Windows 尝试自动打开。
5. 保持终端窗口运行；Ctrl+C 关闭前后端。无需重新下载前端依赖或执行构建。

端口：前端 5173，API 18080，WebSocket 18081。这是附带预览版本的端口，不改变原 npm 开发入口的默认 8080/8081。
若提示端口占用，请先停止你此前启动的本项目服务，启动器不会强制结束其他进程。

## 看全部页面图片

双击 `ui-demos/index.html`。包含 25 个页面/状态的桌面和手机版，共 50 张完整截图。也可直接看 `UI_OVERVIEW_DESKTOP.png` / `UI_OVERVIEW_MOBILE.png`。

## 源码与交接

- `docs/ui-refresh/UPDATE_REPORT.md`：改动、30秒判负、复盘和已知边界。
- `docs/ui-refresh/CODEX_UI_REFRESH_HANDOFF.md`：给 Codex 的接手说明。
- `docs/ui-refresh/CHANGED_FILES.json`：源文件变更和 hash。
- `docs/ui-refresh/ORIGINAL_FILE_INVENTORY.json`：原压缩包逐文件清单及用途分类。

原项目开发方式仍保留：`npm install`、`npm run dev:backend`、`npm run dev`、`npm run build`。重新标准构建时应按你的实际前后端域名设置 VITE_API_URL / VITE_WS_URL，不能把本地预览端口当成生产地址。

## 两点说明

- 正式规则仍是前五回合无人持权，第六回合起白→绿→红，13/17路；未改游戏规则与五档AI。
- 第25手合法获胜与当前规则冲突，首页采用实际运行原 MaxN 得到的第27手白棋胜局，完整棋谱在交付说明中。

## 合并到旧仓库

先备份旧目录。只合并本次修改的源码及新增文件；保留你正在使用的 `.git`、环境配置和最新数据库，不要用 ZIP 中的旧数据库覆盖已经继续使用的数据库。完整包保留上传时数据库快照，因此请勿未经清理就发布整个 ZIP 到公开 GitHub。
