import { messageText, errorText } from "../i18n/core";
import { tx, encodeMessage } from "../i18n/core";
import { useLocale } from "../i18n/react";
/**
 * 管理控制台（规格 7.2 / 验收 O03 收口）。
 *
 * 只做三件规格点名的事，其余不做：
 *  - 健康/队列/活跃房间/版本/终局原因/AI 延迟：一屏看完；
 *  - 举报队列：人工复核（可复核/驳回/已处理），**不做任何自动处罚**；
 *  - 数据导出与删除请求、题库与审计：可查，操作留痕。
 *
 * 三条纪律：
 *  1. 入口只对 role=ADMIN 显示，但每个接口服务端都独立鉴权（前端隐藏不是权限）；
 *  2. 页面不渲染任何用户身份信息（管理接口本身也不返回）；
 *  3. 评分历史只追加：界面上没有任何“改分/覆盖历史”的按钮。
 */
import { useCallback, useEffect, useState } from 'react';
import { adminApi, api, API_BASE, type AdminAuditRow, type AdminDataTask, type AdminDatasetRun, type AdminLive, type AdminReport, type PublicUser, } from '../api';
import { formatTime } from './reviewCopy';
interface ReadyReport {
    ready: boolean;
    checks: Array<{
        name: string;
        state: string;
        detail: string;
    }>;
    metrics?: {
        rssBytes: number;
        heapUsedBytes: number;
        cpuCount: number;
    };
    version?: {
        releaseId: string;
        rulesetVersion: string;
        protocolVersion: number;
    };
    source?: {
        backendSourceSha: string | null;
        frontendSourceSha: string | null;
    };
    uptimeMs?: number;
}
export function AdminPage({ user }: {
    user: PublicUser;
}) {
    useLocale();
    const [live, setLive] = useState<AdminLive | null>(null);
    const [ready, setReady] = useState<ReadyReport | null>(null);
    const [version, setVersion] = useState<Record<string, unknown> | null>(null);
    const [reports, setReports] = useState<AdminReport[]>([]);
    const [audit, setAudit] = useState<AdminAuditRow[]>([]);
    const [tasks, setTasks] = useState<AdminDataTask[]>([]);
    const [runs, setRuns] = useState<AdminDatasetRun[]>([]);
    const [err, setErr] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const load = useCallback(async () => {
        try {
            const [l, r, a, t, d, v] = await Promise.all([
                adminApi.live(),
                adminApi.reports('PENDING'),
                adminApi.audit(),
                adminApi.dataTasks(),
                adminApi.datasetRuns(),
                api<Record<string, unknown>>('GET', '/api/version'),
            ]);
            setLive(l.data);
            setReports(r.data.reports);
            setAudit(a.data.audit);
            setTasks(t.data.tasks);
            setRuns(d.data.runs);
            setVersion(v.data);
            setErr('');
        }
        catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        }
        try {
            const res = await fetch(API_BASE + '/ready');
            setReady((await res.json()) as ReadyReport);
        }
        catch {
            setReady(null);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    const review = useCallback(async (reportId: string, status: 'REVIEWED' | 'DISMISSED' | 'ACTIONED') => {
        setBusy(true);
        try {
            await adminApi.reviewReport(reportId, status, '管理台人工复核');
            setNotice(encodeMessage("已记录复核结论\uFF08{p0}\uFF09。处罚与改分仍需人工流程\uFF0C界面不提供自动处罚。", { p0: status }));
            await load();
        }
        catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    }, [load]);
    if (user.role !== 'ADMIN') {
        return (<main className="rv-page" data-testid="admin-page">
        <div className="rv-page-head"><h1>{tx("管理控制台")}</h1></div>
        <p className="rv-alert" data-testid="admin-forbidden">{tx("当前账号不是管理员。管理角色由受控 CLI 授予\uFF08不硬编码邮箱\uFF09\uFF0C并且每个管理接口在服务端独立鉴权。")}</p>
      </main>);
    }
    const ops = live?.ops ?? null;
    // 三层部署对账：前端 bundle 里烘焙的构建提交 vs 后端自报提交。
    // 只在前端 sha 真的被注入（Netlify 注入 COMMIT_REF）时才可能给出“同提交”。
    const backendSha = (((version as any)?.source?.backendSourceSha ?? null) as string | null);
    const frontendSha = __SRSZQ_SOURCE_SHA__;
    const sameCommit = frontendSha !== 'unknown' && !!backendSha && backendSha.startsWith(frontendSha.slice(0, 7));
    const mb = (n: number | undefined): string => (typeof n === 'number' ? Math.round(n / 1048576) + ' MB' : '—');
    return (<main className="rv-page" data-testid="admin-page">
      <div className="rv-page-head">
        <h1>{tx("管理控制台")}</h1>
        <p className="muted">{tx("只读为主\uFF1A健康、队列、活跃房间、举报队列、数据请求与审计。评分历史只追加\uFF0C界面不提供改分。")}</p>
      </div>
      {err && <p role="alert" className="rv-alert" data-testid="admin-error">{errorText(err)}</p>}
      {notice && <p className="rv-notice" data-testid="admin-notice">{messageText(notice)}</p>}

      <div className="rv-aside-stack">
        <div className="panel" data-testid="admin-system">
          <div className="panel-title">{tx("系统状态")}</div>
          <p data-testid="admin-ready">
            /ready：{ready ? (ready.ready ? tx("就绪") : tx("未就绪")) : tx("读取失败")}
            {ready?.checks?.length ? '（' + ready.checks.map((c) => c.name + '=' + c.state).join(' · ') + '）' : ''}
          </p>
          <p className="muted">{tx("版本\uFF1AreleaseId {p0} \u00B7 ruleset {p1} \u00B7 运行 {p2}", { p0: (version as any)?.protocol?.releaseId ?? '—', p1: (version as any)?.protocol?.rulesetVersion ?? '—', p2: (version as any)?.protocol?.protocolVersion ?? '—' })}</p>
          <p className="muted" data-testid="admin-source-sha">{tx("源码\uFF1Abackend {p0} \u00B7 frontend {p1}", { p0: backendSha ?? tx("未报告"), p1: (version as any)?.source?.frontendSourceSha ?? tx("未报告") })}</p>
          <p className="muted" data-testid="admin-build-sha">{tx("构建对账\uFF1A前端产物由 {p0} 构建 \u00B7 判定 {p1}", { p0: frontendSha, p1: sameCommit ? tx("与后端同提交") : tx("需人工核对") })}</p>
          <p className="muted">{tx("资源\uFF1ARSS {p0} \u00B7 heap {p1} \u00B7 CPU {p2} 核 \u00B7 uptime {p3}", { p0: mb(ready?.metrics?.rssBytes), p1: mb(ready?.metrics?.heapUsedBytes), p2: ready?.metrics?.cpuCount ?? '—', p3: ready?.uptimeMs ? Math.round(ready.uptimeMs / 1000) + 's' : '—' })}</p>
        </div>

        <div className="panel" data-testid="admin-live">
          <div className="panel-title">{tx("队列与活跃房间")}</div>
          <p>{tx("房间 {p0}\uFF08已结束 {p1}\uFF09 \u00B7 WS 连接 {p2} \u00B7 队列中 {p3} \u00B7 进行中记录 {p4}", { p0: ops?.rooms ?? '—', p1: ops?.roomsEnded ?? '—', p2: ops?.wsClients ?? '—', p3: ops?.queuedEntries ?? '—', p4: live?.db.liveGames ?? '—' })}</p>
          <p className="muted">{tx("AI 池 {p0}\uFF08预热 {p1}\uFF09\u00B7 运行中 {p2} \u00B7 排队 {p3} \u00B7 超时 {p4} \u00B7 拒绝 {p5} \u00B7 重建 {p6}", { p0: ops?.worker.poolSize ?? '—', p1: ops?.worker.warm ?? '—', p2: ops?.worker.running ?? '—', p3: ops?.worker.queued ?? '—', p4: ops?.worker.timedOut ?? '—', p5: ops?.worker.rejected ?? '—', p6: ops?.worker.respawns ?? '—' })}</p>
          <p className="muted">{tx("近 24h\uFF1A结算 {p0} 局 \u00B7 真人开局 {p1} \u00B7 真人终局 {p2}\uFF08{p3}\uFF09", { p0: live?.db.settledToday ?? '—', p1: live?.events.matchStartsHumanOnly.total ?? '—', p2: live?.events.matchFinishesHumanOnly.total ?? '—', p3: tx(live?.events.rule ?? '') })}</p>
          <p className="muted">{tx("题库已发布 {p0} 道 \u00B7 数据集运行 {p1} 次", { p0: live?.db.publishedPuzzles ?? '—', p1: live?.db.datasetRuns ?? '—' })}</p>
        </div>

        <div className="panel" data-testid="admin-reports">
          <div className="panel-title">{tx("举报队列 \u00B7 待处理 {p0}", { p0: reports.length })}</div>
          {reports.length === 0 && <p className="muted" data-testid="admin-reports-empty">{tx("没有待处理举报。")}</p>}
          <ul className="rv-wrong">
            {reports.map((r) => (<li key={r.reportId} data-testid="admin-report-row">
                <span>{r.targetKind} · {r.reason}</span>
                <span className="muted">{formatTime(r.createdAt)}</span>
                <span>
                  <button className="linklike" disabled={busy} onClick={() => void review(r.reportId, 'REVIEWED')}>{tx("已复核")}</button>
                  {' / '}
                  <button className="linklike" disabled={busy} onClick={() => void review(r.reportId, 'DISMISSED')}>{tx("驳回")}</button>
                  {' / '}
                  <button className="linklike" disabled={busy} onClick={() => void review(r.reportId, 'ACTIONED')}>{tx("已处理")}</button>
                </span>
              </li>))}
          </ul>
          <p className="muted" data-testid="admin-reports-note">{tx("不做自动处罚\uFF1A这里只记录人工复核结论。")}</p>
        </div>

        <div className="panel" data-testid="admin-data-tasks">
          <div className="panel-title">{tx("数据导出 / 删除请求")}</div>
          {tasks.length === 0 && <p className="muted" data-testid="admin-tasks-empty">{tx("暂无请求。")}</p>}
          <ul className="rv-wrong">
            {tasks.map((t) => (<li key={t.taskId} data-testid="admin-task-row">
                <span>{t.kind}</span>
                <span className="muted">{t.status} · {formatTime(t.requestedAt)}</span>
                <span className="muted">{t.error ?? ''}</span>
              </li>))}
          </ul>
        </div>

        <div className="panel" data-testid="admin-dataset">
          <div className="panel-title">{tx("数据集运行登记")}</div>
          {runs.length === 0 && <p className="muted" data-testid="admin-dataset-empty">{tx("尚无运行登记。")}</p>}
          <ul className="rv-wrong">
            {runs.map((r) => (<li key={r.runId} data-testid="admin-dataset-row">
                <span>{r.seedFrom}–{r.seedTo}</span>
                <span className="muted">{tx("{p0} \u00B7 {p1} \u00B7 {p2} 样本", { p0: r.engineVersion, p1: r.budget, p2: r.uniqueSampleCount })}</span>
                <span className="muted">{formatTime(r.createdAt)}</span>
              </li>))}
          </ul>
        </div>

        <div className="panel" data-testid="admin-audit">
          <div className="panel-title">{tx("审计\uFF08最近 {p0} 条\uFF09", { p0: audit.length })}</div>
          <ul className="rv-wrong">
            {audit.slice(0, 20).map((a) => (<li key={a.id} data-testid="admin-audit-row">
                <span>{a.action}</span>
                <span className="muted">{a.actorRole} · {a.targetKind ?? '—'}</span>
                <span className="muted">{formatTime(a.createdAt)}</span>
              </li>))}
          </ul>
        </div>
      </div>
    </main>);
}
