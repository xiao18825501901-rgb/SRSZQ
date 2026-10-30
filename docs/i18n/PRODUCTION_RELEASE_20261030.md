# SRSZQ 双语生产发布记录 — 2026-10-30

状态：**DEPLOYED_AND_SMOKE_VERIFIED**。

- 正式地址：https://srszq.com
- Site ID：8ba9ce96-b7ec-409a-965c-10d6e2335bf2
- 生产 Deploy ID：6ae45b23fd1ffcb46b307278
- 部署固定地址：https://6ae45b23fd1ffcb46b307278--srszq.netlify.app
- 部署源码：fa2fe9af8575dd37217f68071bf03be04cce7a6b；功能代码 eab686cd4bfbf8a17a8d00e2256475cf962e1361。
- 原生产 Deploy：6abe5dee0076690008787e75。

## 实际发布过程
Netlify连接器要求重新认证，但本机CLI现有会话有效，使用CLI完成发布。明确选定前端workspace及既有site，没有新建站点或改变访问权限。
从已通过189项原生单测的同一代码构建生产版，VITE_API_URL=https://api.srszq.com、VITE_WS_URL=wss://api.srszq.com/ws，COMMIT_REF/fa2fe9af8575dd37217f68071bf03be04cce7a6b固定为部署源码。产物单独位于 evidence/production-20261030/dist，保留此前本地验收产物。
生产构建验证了正确端点、源码指纹、正常入口不含验收脚本、无localhost API/WSS。先创建draft并逐一比对10个线上文件hash，再以同一目录创建production deploy。站点API确认新deploy为published且ready。

## 发布后验证
- 正式域名全部10个文件：HTTP200，SHA256与生产构建一致。
- 真实浏览器：首页中文/English、HTML lang/title、刷新语言持久化通过。
- 手机390×844首页无横向溢出；17路棋盘289交叉点、无横向溢出；浏览器warn/error日志为空。
- api.srszq.com/ready：发布前后通过；服务端协议2、formal-rules-v2兼容。
- 使用保留example域名的TEST账号实测注册→密码登录→一次性WS票据→wss认证hello→注销，全通过。无凭据出现在URL或报告，未进入真人匹配队列。保留1个合成冒烟账号，未改数据库结构或既有用户数据。
- 未改变后端程序、共享规则、服务器、DNS；未推送GitHub main。

## 发布方式与后续自动构建
本次是Netlify手动静态发布。站点仍连接GitHub main，目前main为1878587c36121ef5805b67d6fb06c1a8aa5d69cc。未来main自动构建可能替换本版本；下一次Git部署前应同步本轮代码。如需固定当前手动版本，可在Netlify锁定自动发布。本次没有擅自修改该设置。

## 出现异常时
失败的deploy不会切换正式站点。若已发布版本出现问题，依据保留的源码/产物指纹修正代码，或在独立分支revert相关源码后构建并发布新的修复版本；不恢复旧deploy对象。不改生产数据库，不操作DNS。

## 证据
PRODUCTION_RELEASE_20261030.json包含部署ID、发布状态、全部构建hash与浏览器/API/WS结果。原始构建输出、Netlify回执、draft/production文件核对和线上截图位于本工作区 evidence/production-20261030。
