import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, getAccessToken } from '../../api/client';
import { Avatar, Button, EmptyState, Select, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { ACTION_GROUPS, ACTION_LABELS } from '../../lib/constants';
import { formatDateTime } from '../../lib/format';
import type { AuditLog, AuditPageInfo, AuditVerification, Member } from '../../api/types';

interface AuditResponse {
  logs: AuditLog[];
  page: AuditPageInfo;
}

/** 当前生效的筛选条件（点击「查询」后才提交，避免每敲一个字就请求） */
interface Filters {
  actions: string[];
  actorId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { actions: [], actorId: '', from: '', to: '' };

function buildQuery(filters: Filters, cursor?: string | null, limit = 60): string {
  const params = new URLSearchParams();
  for (const action of filters.actions) params.append('action', action);
  if (filters.actorId) params.set('actorId', filters.actorId);
  if (filters.from) params.set('from', new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59.999`).toISOString());
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function AuditPage() {
  const { fid } = useParams<{ fid: string }>();
  const { push } = useToast();

  // 表单态 vs 已提交态
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [verifying, setVerifying] = useState(false);

  const membersQuery = useQuery({
    queryKey: ['members', fid],
    queryFn: () => api.get<{ members: Member[] }>(`/families/${fid}/members`),
    enabled: Boolean(fid),
  });

  const list = useInfiniteQuery({
    queryKey: ['audit', fid, applied],
    queryFn: ({ pageParam }) =>
      api.get<AuditResponse>(`/families/${fid}/audit-logs?${buildQuery(applied, pageParam ?? null)}`),
    enabled: Boolean(fid),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.page.nextCursor,
  });

  const logs = useMemo(() => list.data?.pages.flatMap((p) => p.logs) ?? [], [list.data]);

  function toggleAction(action: string) {
    setDraft((d) => ({
      ...d,
      actions: d.actions.includes(action) ? d.actions.filter((a) => a !== action) : [...d.actions, action],
    }));
  }

  function applyFilters() {
    setApplied(draft);
  }

  function resetFilters() {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  }

  /** 导出 CSV：直接用当前筛选条件，浏览器带鉴权头下载 */
  function exportCsv() {
    const token = getAccessToken();
    const url = `/api/v1/families/${fid}/audit-logs?${buildQuery(applied, null, 200)}&format=csv`;
    fetch(url, { credentials: 'include', headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? '导出失败');
        const digest = res.headers.get('X-Audit-Range-Digest');
        const intact = res.headers.get('X-Audit-Chain-Intact');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        if (digest) {
          push(
            intact === 'true'
              ? `已导出，范围摘要 ${digest.slice(0, 12)}…（链完整，可随时复算）`
              : `已导出，但哈希链校验未通过（${digest.slice(0, 12)}…），请尽快排查`,
            intact === 'true' ? 'success' : 'error',
          );
        }
      })
      .catch((err) => push(err instanceof Error ? err.message : '导出失败', 'error'));
  }

  async function verify() {
    setVerifying(true);
    try {
      const params = new URLSearchParams();
      for (const action of applied.actions) params.append('action', action);
      if (applied.actorId) params.set('actorId', applied.actorId);
      if (applied.from) params.set('from', new Date(`${applied.from}T00:00:00`).toISOString());
      if (applied.to) params.set('to', new Date(`${applied.to}T23:59:59.999`).toISOString());
      const { verification } = await api.get<{ verification: AuditVerification }>(
        `/families/${fid}/audit-logs/verify?${params.toString()}`,
      );
      if (verification.chainIntact) {
        push(
          `校验通过：当前范围 ${verification.total} 条，范围摘要 ${verification.rangeDigest.slice(0, 16)}…`,
          'success',
        );
      } else {
        push(`哈希链异常，断裂位置 seq：${verification.brokenAt.slice(0, 5).join('、')}`, 'error');
      }
    } catch (err) {
      push(err instanceof Error ? err.message : '复算失败', 'error');
    } finally {
      setVerifying(false);
    }
  }

  const hasDraft =
    draft.actions.length > 0 || Boolean(draft.actorId) || Boolean(draft.from) || Boolean(draft.to);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>家庭动态</h1>
          <p className="page-head__sub">
            谁在什么时候新建、修改、删除了什么，都会留下记录。日志只追加、不可修改，可按时间范围复算摘要。
          </p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Button onClick={verify} loading={verifying}>
            复算校验
          </Button>
          <Button variant="primary" onClick={exportCsv}>
            导出 CSV
          </Button>
        </div>
      </div>

      <section className="card stack" style={{ gap: 'var(--space-3)' }}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field__label">成员</label>
            <Select value={draft.actorId} onChange={(e) => setDraft({ ...draft, actorId: e.target.value })}>
              <option value="">全部成员</option>
              {membersQuery.data?.members
                .filter((m) => m.status === 'active')
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user.displayName}
                  </option>
                ))}
            </Select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field__label">开始日期</label>
            <input
              type="date"
              className="input"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field__label">结束日期</label>
            <input
              type="date"
              className="input"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </div>
        </div>

        <div>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-2)' }}>
            <span className="muted" style={{ fontSize: 13 }}>
              操作类型{draft.actions.length > 0 ? `（已选 ${draft.actions.length} 类，AND 组合）` : '（不选即全部）'}
            </span>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <Button size="sm" onClick={resetFilters} disabled={!hasDraft}>
                清空
              </Button>
              <Button size="sm" variant="primary" onClick={applyFilters}>
                查询
              </Button>
            </div>
          </div>
          <div className="stack" style={{ gap: 'var(--space-1)' }}>
            {ACTION_GROUPS.map((group) => (
              <div key={group.label} className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span className="muted" style={{ fontSize: 12, minWidth: 84 }}>
                  {group.label}
                </span>
                {group.actions.map((action) => {
                  const active = draft.actions.includes(action);
                  return (
                    <button
                      key={action}
                      type="button"
                      className={`tag tag--checkable${active ? ' is-active' : ''}`}
                      onClick={() => toggleAction(action)}
                      aria-pressed={active}
                    >
                      {ACTION_LABELS[action] ?? action}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <EmptyState icon="⚠️" title="加载失败" description="请稍后重试，或检查网络连接。" />
      ) : logs.length === 0 ? (
        <EmptyState icon="📝" title="没有匹配的记录" description="换个筛选条件试试，或让家人先开始建立条目。" />
      ) : (
        <section className="card stack" style={{ gap: 0 }}>
          <div className="log-list">
            {logs.map((log) => (
              <div key={log.id} className="log-item">
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
                    {log.seq ? (
                      <span className="muted" style={{ fontSize: 11 }} title="全局序号，分页与防篡改锚点">
                        #{log.seq}
                      </span>
                    ) : null}
                  </div>
                  <AuditDiffView diff={log.diff} />
                  <div className="log-item__meta">
                    {formatDateTime(log.createdAt)}
                    {log.ip ? ` · ${log.ip}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {list.hasNextPage ? (
            <div style={{ padding: 'var(--space-3)', textAlign: 'center' }}>
              <Button onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
                加载更早的记录
              </Button>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

/** 把脱敏后的 diff 简要展开，键名命中密码/令牌类的只显示 *** */
function AuditDiffView({ diff }: { diff: unknown }) {
  if (!diff || typeof diff !== 'object') return null;
  const entries = Object.entries(diff as Record<string, unknown>);
  if (!entries.length) return null;
  return (
    <details className="log-diff">
      <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
        变更详情
      </summary>
      <pre className="log-diff__body">{JSON.stringify(diff, null, 2)}</pre>
    </details>
  );
}
