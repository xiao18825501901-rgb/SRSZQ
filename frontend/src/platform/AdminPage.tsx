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
import {
  adminApi, api, API_BASE,
  type AdminAuditRow, type AdminDataTask, type AdminDatasetRun, type AdminLive, type AdminReport, type PublicUser,
} from '../api';
import { formatTime } from './reviewCopy';

interface ReadyReport {
  ready: boolean;
  checks: Array<{ name: string; state: string; detail: string }>;
  metrics?: { rssBytes: number; heapUsedBytes: number; cpuCount: number };
  version?: { releaseId: string; rulesetVersion: string; protocolVersion: number };
  source?: { backendSourceSha: string | null; frontendSourceSha: string | null };
  uptimeMs?: number;
}

export function AdminPage({ user }: { user: PublicUser }) {
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
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    try {
      const res = await fetch(API_BASE + '/ready');
      setReady((await res.json()) as ReadyReport);
    } catch {
      setReady(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const review = useCallback(async (reportId: string, status: 'REVIEWED' | 'DISMISSED' | 'ACTIONED') => {
    setBusy(true);
    try {
      await adminApi.reviewReport(reportId, status, '管理台人工复核');
      setNotice('已记录复核结论（' + status + '）。处罚与改分仍需人工流程，界面不提供自动处罚。');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (user.role !== 'ADMIN') {
    return (
      <main className="rv-page" data-testid="admin-page">
        <div className="rv-page-head"><h1>管理控制台</h1></div>
        <p className="rv-alert" data-testid="admin-forbidden">
          当前账号不是管理员。管理角色由受控 CLI 授予（不硬编码邮箱），并且每个管理接口在服务端独立鉴权。
        </p>
      </main>
    );
  }

  const ops = live?.ops ?? null;
  const mb = (n: number | undefined): string => (typeof n === 'number' ? Math.round(n / 1048576) + ' MB' : '—');

  return (
    <main className="rv-page" data-testid="admin-page">
      <div className="rv-page-head">
        <h1>管理控制台</h1>
        <p className="muted">只读为主：健康、队列、活跃房间、举报队列、数据请求与审计。评分历史只追加，界面不提供改分。</p>
      </div>
      {err && <p role="alert" className="rv-alert" data-testid="admin-error">{err}</p>}
      {notice && <p className="rv-notice" data-testid="admin-notice">{notice}</p>}

      <div className="rv-aside-stack">
        <div className="panel" data-testid="admin-system">
          <div className="panel-title">系统状态</div>
          <p data-testid="admin-ready">
            /ready：{ready ? (ready.ready ? '就绪' : '未就绪') : '读取失败'}
            {ready?.checks?.length ? '（' + ready.checks.map((c) => c.name + '=' + c.state).join(' · ') + '）' : ''}
          </p>
          <p className="muted">
            版本：releaseId {(version as any)?.protocol?.releaseId ?? '—'} · ruleset {(version as any)?.protocol?.rulesetVersion ?? '—'} ·
            运行 {(version as any)?.protocol?.protocolVersion ?? '—'}
          </p>
          <p className="muted" data-testid="admin-source-sha">
            源码：backend {(version as any)?.source?.backendSourceSha ?? '未报告'} · frontend {(version as any)?.source?.frontendSourceSha ?? '未报告'}
          </p>
          <p className="muted">
            资源：RSS {mb(ready?.metrics?.rssBytes)} · heap {mb(ready?.metrics?.heapUsedBytes)} · CPU {ready?.metrics?.cpuCount ?? '—'} 核 ·
            uptime {ready?.uptimeMs ? Math.round(ready.uptimeMs / 1000) + 's' : '—'}
          </p>
        </div>

        <div className="panel" data-testid="admin-live">
          <div className="panel-title">队列与活跃房间</div>
          <p>
            房间 {ops?.rooms ?? '—'}（已结束 {ops?.roomsEnded ?? '—'}） · WS 连接 {ops?.wsClients ?? '—'} · 队列中 {ops?.queuedEntries ?? '—'} ·
            进行中记录 {live?.db.liveGames ?? '—'}
          </p>
          <p className="muted">
            AI 池 {ops?.worker.poolSize ?? '—'}（预热 {ops?.worker.warm ?? '—'}）· 运行中 {ops?.worker.running ?? '—'} · 排队 {ops?.worker.queued ?? '—'} ·
            超时 {ops?.worker.timedOut ?? '—'} · 拒绝 {ops?.worker.rejected ?? '—'} · 重建 {ops?.worker.respawns ?? '—'}
          </p>
          <p className="muted">
            近 24h：结算 {live?.db.settledToday ?? '—'} 局 · 真人开局 {live?.events.matchStartsHumanOnly.total ?? '—'} ·
            真人终局 {live?.events.matchFinishesHumanOnly.total ?? '—'}（{live?.events.rule ?? ''}）
          </p>
          <p className="muted">题库已发布 {live?.db.publishedPuzzles ?? '—'} 道 · 数据集运行 {live?.db.datasetRuns ?? '—'} 次</p>
        </div>

        <div className="panel" data-testid="admin-reports">
          <div className="panel-title">举报队列 · 待处理 {reports.length}</div>
          {reports.length === 0 && <p className="muted" data-testid="admin-reports-empty">没有待处理举报。</p>}
          <ul className="rv-wrong">
            {reports.map((r) => (
              <li key={r.reportId} data-testid="admin-report-row">
                <span>{r.targetKind} · {r.reason}</span>
                <span className="muted">{formatTime(r.createdAt)}</span>
                <span>
                  <button className="linklike" disabled={busy} onClick={() => void review(r.reportId, 'REVIEWED')}>已复核</button>
                  {' / '}
                  <button className="linklike" disabled={busy} onClick={() => void review(r.reportId, 'DISMISSED')}>驳回</button>
                  {' / '}
                  <button className="linklike" disabled={busy} onClick={() => void review(r.reportId, 'ACTIONED')}>已处理</button>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted" data-testid="admin-reports-note">不做自动处罚：这里只记录人工复核结论。</p>
        </div>

        <div className="panel" data-testid="admin-data-tasks">
          <div className="panel-title">数据导出 / 删除请求</div>
          {tasks.length === 0 && <p className="muted" data-testid="admin-tasks-empty">暂无请求。</p>}
          <ul className="rv-wrong">
            {tasks.map((t) => (
              <li key={t.taskId} data-testid="admin-task-row">
                <span>{t.kind}</span>
                <span className="muted">{t.status} · {formatTime(t.requestedAt)}</span>
                <span className="muted">{t.error ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel" data-testid="admin-dataset">
          <div className="panel-title">数据集运行登记</div>
          {runs.length === 0 && <p className="muted" data-testid="admin-dataset-empty">尚无运行登记。</p>}
          <ul className="rv-wrong">
            {runs.map((r) => (
              <li key={r.runId} data-testid="admin-dataset-row">
                <span>{r.seedFrom}–{r.seedTo}</span>
                <span className="muted">{r.engineVersion} · {r.budget} · {r.uniqueSampleCount} 样本</span>
                <span className="muted">{formatTime(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel" data-testid="admin-audit">
          <div className="panel-title">审计（最近 {audit.length} 条）</div>
          <ul className="rv-wrong">
            {audit.slice(0, 20).map((a) => (
              <li key={a.id} data-testid="admin-audit-row">
                <span>{a.action}</span>
                <span className="muted">{a.actorRole} · {a.targetKind ?? '—'}</span>
                <span className="muted">{formatTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
