import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, getAccessToken } from '../../api/client';
import { Avatar, Button, EmptyState, Field, Select, Spinner, Tag, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { ACTION_LABELS } from '../../lib/constants';
import { formatDateTime } from '../../lib/format';
import type { AuditLog, AuditPageData, AuditVerifyResult, Member } from '../../api/types';

const PAGE_SIZE = 50;

function localToIso(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function isoToLocal(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AuditPage() {
  const { fid } = useParams<{ fid: string }>();
  const { push } = useToast();
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [fromLocal, setFromLocal] = useState('');
  const [toLocal, setToLocal] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<AuditVerifyResult | null>(null);

  const members = useQuery({
    queryKey: ['members', fid],
    queryFn: () => api.get<{ members: Member[] }>(`/families/${fid}/members`),
    enabled: Boolean(fid),
  });

  const filters = useMemo(
    () => ({ action, actorId, from: localToIso(fromLocal), to: localToIso(toLocal) }),
    [action, actorId, fromLocal, toLocal],
  );

  const buildQuery = (cursor?: string) => {
    const search = new URLSearchParams();
    search.set('limit', String(PAGE_SIZE));
    if (filters.action) search.set('action', filters.action);
    if (filters.actorId) search.set('actorId', filters.actorId);
    if (filters.from) search.set('from', filters.from);
    if (filters.to) search.set('to', filters.to);
    if (cursor) search.set('cursor', cursor);
    return search.toString();
  };

  const list = useInfiniteQuery({
    queryKey: ['audit', fid, filters],
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) =>
      api.get<AuditPageData>(`/families/${fid}/audit-logs?${buildQuery(pageParam || undefined)}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(fid),
  });

  const logs = list.data?.pages.flatMap((p) => p.logs) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;

  const resetVerify = () => setVerifyResult(null);

  const exportCsv = async () => {
    try {
      const token = getAccessToken();
      const res = await fetch(`/api/v1/families/${fid}/audit-logs/export?${buildQuery()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`导出失败（${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const digest = res.headers.get('X-Audit-Digest');
      const count = res.headers.get('X-Audit-Count');
      a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      push(`已导出 ${count ?? 0} 条审计记录${digest ? `，摘要 ${digest.slice(0, 12)}…` : ''}`, 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '导出失败', 'error');
    }
  };

  const verify = async () => {
    setVerifying(true);
    try {
      const data = await api.get<{ result: AuditVerifyResult }>(
        `/families/${fid}/audit-logs/verify?${buildQuery()}`,
      );
      setVerifyResult(data.result);
      if (data.result.intact) push('时间范围内的审计链完整，未发现篡改', 'success');
      else push('审计链校验发现异常，请查看校验结果', 'error');
    } catch (err) {
      push(err instanceof Error ? err.message : '校验失败', 'error');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>家庭动态</h1>
          <p className="page-head__sub">
            谁在什么时候新建、修改、删除了什么，都会留下记录。每条记录都带防篡改哈希链，可随时复算校验。
          </p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Button onClick={verify} loading={verifying}>
            校验完整性
          </Button>
          <Button variant="primary" onClick={exportCsv}>
            导出 CSV
          </Button>
        </div>
      </div>

      <section className="card" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div className="filters" style={{ marginBottom: 0 }}>
          <Field label="操作类型">
            <Select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                resetVerify();
              }}
            >
              <option value="">全部操作</option>
              {Object.entries(ACTION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="成员">
            <Select
              value={actorId}
              onChange={(e) => {
                setActorId(e.target.value);
                resetVerify();
              }}
            >
              <option value="">全部成员</option>
              {(members.data?.members ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="开始时间">
            <TextInput type="datetime-local" value={fromLocal} max={toLocal || undefined} onChange={(e) => { setFromLocal(e.target.value); resetVerify(); }} />
          </Field>
          <Field label="结束时间">
            <TextInput type="datetime-local" value={toLocal} min={fromLocal || undefined} onChange={(e) => { setToLocal(e.target.value); resetVerify(); }} />
          </Field>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          共 {total} 条记录{total > 0 ? `，按时间倒序，每页 ${PAGE_SIZE} 条` : ''}
        </div>
      </section>

      {verifyResult ? <VerifyBanner result={verifyResult} onClose={resetVerify} /> : null}

      {list.isLoading ? (
        <Spinner />
      ) : logs.length === 0 ? (
        <EmptyState icon="📝" title="没有匹配的动态" description="换个操作类型、成员或时间范围试试。" />
      ) : (
        <section className="card">
          <div className="log-list">
            {logs.map((log) => (
              <AuditRow key={log.id} log={log} />
            ))}
          </div>
        </section>
      )}

      {list.hasNextPage ? (
        <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
          加载更早的记录
        </Button>
      ) : logs.length > 0 ? (
        <p className="muted" style={{ textAlign: 'center', fontSize: 13 }}>
          已经到底了
        </p>
      ) : null}
    </div>
  );
}

function AuditRow({ log }: { log: AuditLog }) {
  return (
    <div className="log-item">
      <Avatar name={log.actor.displayName} color={log.actor.avatarColor} size={34} />
      <div className="log-item__body">
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <strong>{log.actor.displayName}</strong>
          <Tag>{ACTION_LABELS[log.action] ?? log.action}</Tag>
          {log.targetType ? (
            <span className="muted" style={{ fontSize: 12 }}>
              {log.targetType}
            </span>
          ) : null}
          <span className="muted" style={{ fontSize: 11 }} title="全局审计序号，也是防篡改哈希链的锚点">
            #{log.seq}
          </span>
        </div>
        <div className="log-item__meta">
          {formatDateTime(log.createdAt)}
          {log.ip ? ` · ${log.ip}` : ''}
        </div>
      </div>
    </div>
  );
}

function VerifyBanner({ result, onClose }: { result: AuditVerifyResult; onClose: () => void }) {
  return (
    <section className={`card`} style={{ borderColor: result.intact ? 'var(--color-success, #3F6B4A)' : 'var(--color-danger, #A44A3F)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{result.intact ? '✅ 审计链完整' : '⚠️ 审计链异常'}</strong>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: 'var(--space-2) 0' }}>
        校验范围：{result.count} 条记录
        {result.firstSeq ? `（#${result.firstSeq} – #${result.lastSeq}）` : ''}
        {result.truncated ? '；范围超过 10000 条上限，请缩小时间范围后重新校验' : ''}
      </p>
      {!result.intact && result.count > 0 && !result.truncated ? (
        <ul style={{ fontSize: 13, margin: 0, paddingLeft: '1.2em' }}>
          {result.tampered.length ? <li>字段被篡改的序号：{result.tampered.slice(0, 20).join(', ')}</li> : null}
          {result.brokenLinks.length ? <li>哈希断链的序号：{result.brokenLinks.slice(0, 20).join(', ')}</li> : null}
          {result.missingSeqs.length ? <li>缺失（疑似删除）的序号：{result.missingSeqs.slice(0, 20).join(', ')}</li> : null}
        </ul>
      ) : null}
      <p className="muted" style={{ fontSize: 12, marginTop: 'var(--space-2)' }}>
        范围摘要（同样筛选复算必得同值）：<code>{result.digest}</code>
      </p>
    </section>
  );
}
