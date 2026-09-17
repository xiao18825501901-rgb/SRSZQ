# 源文件职责与范围

业务源码逐页检查并基于实际接口修改；依赖、大量旧实验/模型输出以及数据库做文件级盘点和哈希保留，没有宣称逐行阅读这些第三方与历史产物。完整原文件清单见 ORIGINAL_FILE_INVENTORY.json。

## 本次变更的已有文件

- `backend/src/api.ts`
- `backend/src/db.ts`
- `backend/src/server.ts`
- `backend/src/ws/gameServer.ts`
- `frontend/dist/index.html`
- `frontend/index.html`
- `frontend/src/api.ts`
- `frontend/src/App.tsx`
- `frontend/src/components/Board.tsx`
- `frontend/src/components/HowToPlay.tsx`
- `frontend/src/hooks/useAIController.ts`
- `frontend/src/main.tsx`
- `frontend/src/platform/OnlinePage.tsx`
- `frontend/src/platform/Platform.tsx`
- `frontend/src/playerPresentation.ts`
- `frontend/src/ui.tsx`
- `frontend/src/ws.ts`

## 新增业务文件

- `frontend/src/components/MatchPanel.tsx`：颜色席位、胜权、提示、复盘控件。
- `frontend/src/components/ModeArtwork.tsx`：四种模式SVG插图。
- `frontend/src/data/heroGame.ts`：真实MaxN终局首页示例。
- `frontend/src/styles/refresh.css`：本次整站新设计。
- `scripts/start-ui-preview.cjs` / `start-ui-preview.bat`：无需重新构建的本地启动。
- `preview-runtime/`：后端与共享源码的编译结果，不是第二套规则源码。
