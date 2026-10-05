import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import { randomHex } from '../utils/crypto';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditInput {
  familyId?: string | null;
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  diff?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/** 创世前缀：链的第一条没有前驱，prevHash 列存 NULL，计算时以空串代替。 */
const GENESIS = '';
/** 规范化格式版本，canonicalLine 布局变化时必须升级。 */
export const CANONICAL_VERSION = 1;
/** 导出单次最多返回的行数，超出请缩小时间范围分段导出。 */
export const EXPORT_LIMIT = 10_000;
export const MAX_PAGE_SIZE = 200;

/* ------------------------------------------------------------------ */
/* 防篡改：规范化 + 哈希链                                              */
/* ------------------------------------------------------------------ */

/**
 * 规范化 JSON：对象键按码点排序，分隔符与 PostgreSQL 的 `jsonb::text`
 * （to_jsonb 输出）完全一致——`: ` 与 `, ` 后带一个空格，空容器无空格。
 *
 * 这样有两个好处：
 * 1. 写库前的 JS 值与 Prisma 读回的 JS 值用同一函数序列化，哈希稳定可复算；
 * 2. DBA 直接在 psql 里也能用 diff::jsonb::text 复算哈希（与本函数字节相同）。
 *
 * 已知边界：非常规数字（NaN/Infinity/超出 JS 安全整数的整数）不在审计数据中出现，
 * 写库内容限定为 string/number/boolean/null/object/array。
 */
export function canonicalJson(value: unknown): string {
  const out = stringifySorted(value);
  if (out === undefined) throw new Error('审计 diff 不可为 undefined');
  return out;
}

function stringifySorted(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const parts = value.map((v) => stringifySorted(v) ?? 'null');
    return `[${parts.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = entries.map(([k, v]) => `${JSON.stringify(k)}: ${stringifySorted(v) ?? 'null'}`);
    return `{${parts.join(', ')}}`;
  }
  // bigint/function/symbol 不允许进入审计 diff
  throw new Error('审计 diff 含有不可序列化的值');
}

/** 固定布局的规范化行。字段顺序/个数变更必须同步迁移 SQL 并升级 CANONICAL_VERSION。 */
export function canonicalLine(input: {
  seq: bigint;
  id: string;
  familyId: string | null;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  diff: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}): string {
  const seq = String(input.seq).padStart(20, '0');
  const time = input.createdAt.toISOString();
  const diff = input.diff === null || input.diff === undefined ? '' : canonicalJson(input.diff);
  return [
    seq,
    input.id,
    input.familyId ?? '',
    input.actorId,
    input.action,
    input.targetType,
    input.targetId ?? '',
    diff,
    input.ip ?? '',
    input.userAgent ?? '',
    time,
  ].join('\t');
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 审计写入。所有写操作都必须在同一事务里调用它，保证「改了但没记录」不可能发生。
 *
 * 哈希链在同一事务内串行追加：pg_advisory_xact_lock 把并发写入排队，
 * 后写入者一定能看到前一条已提交在本事务快照内的链尾（锁互斥保证顺序），
 * 因此链不会分叉；事务回滚则 seq 与链状态一起回滚。
 */
export async function record(input: AuditInput, db?: Db): Promise<void> {
  if (db) return appendChain(input, db);
  await prisma.$transaction((tx) => appendChain(input, tx));
}

async function appendChain(input: AuditInput, db: Db): Promise<void> {
  // 固定的事务级咨询锁（64bit key 1）；随事务提交/回滚自动释放
  await db.$executeRaw`SELECT pg_advisory_xact_lock(872341)`;

  const tail = await db.auditLog.findFirst({
    orderBy: { seq: 'desc' },
    select: { seq: true, entryHash: true },
  });
  const seq = (tail?.seq ?? 0n) + 1n;
  const id = randomHex(12); // 24 字符十六进制，与 cuid 同样不可猜测
  const createdAt = new Date();
  const prevHash = tail?.entryHash ?? null;

  const entryHash = sha256(
    (tail?.entryHash ?? GENESIS) +
      canonicalLine({
        seq,
        id,
        familyId: input.familyId ?? null,
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        diff: input.diff ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        createdAt,
      }),
  );

  await db.auditLog.create({
    data: {
      id,
      seq,
      familyId: input.familyId ?? null,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      diff: (input.diff ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      prevHash,
      entryHash,
      createdAt,
    },
  });
}

/** 审计失败不应掩盖主流程错误，用于无法纳入事务的旁路场景。 */
export async function recordSoft(input: AuditInput): Promise<void> {
  try {
    await record(input);
  } catch (err) {
    logger.error({ err, action: input.action }, '审计写入失败');
  }
}

export function diffOf(before: unknown, after: unknown): Prisma.InputJsonValue {
  return { before, after } as unknown as Prisma.InputJsonValue;
}

/* ------------------------------------------------------------------ */
/* 组合筛选 + 游标分页（锚点为全局 seq，同毫秒也稳定）                  */
/* ------------------------------------------------------------------ */

export interface AuditFilter {
  familyId: string;
  actions?: string[];
  actorId?: string;
  targetType?: string;
  from?: Date;
  to?: Date;
  /** 只取 seq < cursorSeq 的记录（向前翻页） */
  cursorSeq?: bigint;
  limit?: number;
}

function buildWhere(filter: AuditFilter): Prisma.AuditLogWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (filter.from) createdAt.gte = filter.from;
  if (filter.to) createdAt.lte = filter.to;
  return {
    familyId: filter.familyId,
    ...(filter.actions?.length ? { action: { in: filter.actions } } : {}),
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.targetType ? { targetType: filter.targetType } : {}),
    ...(Object.keys(createdAt).length ? { createdAt } : {}),
    ...(filter.cursorSeq ? { seq: { lt: filter.cursorSeq } } : {}),
  };
}

/** 审计列表页：多取一条判断是否还有下一页。 */
export async function queryLogs(filter: AuditFilter, limit = 60) {
  const take = Math.min(MAX_PAGE_SIZE, Math.max(1, limit)) + 1;
  const rows = await prisma.auditLog.findMany({
    where: buildWhere(filter),
    include: { actor: { select: { id: true, displayName: true, avatarColor: true } } },
    orderBy: { seq: 'desc' },
    take,
  });
  const hasMore = rows.length === take;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page,
    nextCursorSeq: hasMore && page.length ? page[page.length - 1]!.seq : null,
  };
}

/* ------------------------------------------------------------------ */
/* 时间范围复算：范围摘要 + 哈希链校验                                  */
/* ------------------------------------------------------------------ */

export interface AuditVerification {
  /** 参与校验的记录条数（该家庭在筛选范围内，按 seq 升序） */
  total: number;
  /**
   * 范围摘要：按 seq 升序对筛选范围内每条 entryHash 折叠哈希。
   * 相同筛选条件（时间范围闭区间）在任何时候复算都一致；
   * 新增日志只会落在范围之外（时间向前推进），历史范围摘要不变。
   */
  rangeDigest: string;
  /** 该家庭全链（按 seq 升序）是否连续且每条重算哈希都一致 */
  chainIntact: boolean;
  /** 最早/最晚记录时间，便于界面展示本次复算覆盖的区间 */
  firstAt: string | null;
  lastAt: string | null;
  /** 链首 seq（可能因迁移/截断为空） */
  firstSeq: string | null;
  /** 发现断裂的位置：seq 列表（缺环/哈希不符），为空表示完好 */
  brokenAt: string[];
}

/**
 * 复算某个家庭的审计完整性，并给出筛选范围内的范围摘要。
 * seq 是全局递增的（跨家庭连续），因此先拉全局链验证整体，
 * 再按 familyId 提取该家庭的子链验证 prevHash 衔接，最后做筛选范围摘要。
 */
export async function verifyFamily(filter: AuditFilter): Promise<AuditVerification> {
  const globalRows = await prisma.auditLog.findMany({
    orderBy: { seq: 'asc' },
    select: {
      seq: true,
      id: true,
      familyId: true,
      actorId: true,
      action: true,
      targetType: true,
      targetId: true,
      diff: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      prevHash: true,
      entryHash: true,
    },
  });

  const brokenAt: string[] = [];

  // 1) 全局链：seq 从 1 连续、prevHash 指向前一条、每条 entryHash 可重算
  //    （entryHash 为 null 表示该行尚未完成哈希回填，记为断裂）
  let expectedPrev: string | null = null;
  let prevSeq: bigint | null = null;
  for (const row of globalRows) {
    if (prevSeq === null) {
      if (row.seq !== 1n) brokenAt.push(row.seq.toString()); // 链首缺失
    } else if (row.seq !== prevSeq + 1n) {
      brokenAt.push(row.seq.toString()); // 中间缺环
    }
    if ((row.prevHash ?? null) !== expectedPrev) brokenAt.push(row.seq.toString());

    if (row.entryHash === null) {
      brokenAt.push(row.seq.toString()); // 尚未回填
    } else {
      const recomputed = sha256(
        (expectedPrev ?? GENESIS) +
          canonicalLine({
            seq: row.seq,
            id: row.id,
            familyId: row.familyId,
            actorId: row.actorId,
            action: row.action,
            targetType: row.targetType,
            targetId: row.targetId,
            diff: row.diff ?? null,
            ip: row.ip,
            userAgent: row.userAgent,
            createdAt: row.createdAt,
          }),
      );
      if (recomputed !== row.entryHash) brokenAt.push(row.seq.toString());
    }

    expectedPrev = row.entryHash;
    prevSeq = row.seq;
  }

  // 2) 该家庭的子链（跨家庭的全局链已在上面逐行校验，这里只取子集）
  const familyRows = globalRows.filter((r) => r.familyId === filter.familyId);

  // 3) 筛选范围摘要（仅在该家庭内按 action/actor/时间过滤）
  const rangeRows = familyRows.filter((row) => {
    if (filter.actions?.length && !filter.actions.includes(row.action)) return false;
    if (filter.actorId && row.actorId !== filter.actorId) return false;
    if (filter.targetType && row.targetType !== filter.targetType) return false;
    if (filter.from && row.createdAt < filter.from) return false;
    if (filter.to && row.createdAt > filter.to) return false;
    return true;
  });

  // 折叠（升序）：d0 = sha256(version|entry0)，dN = sha256(dN-1|entryN)
  // 未回填哈希的行不参与摘要（此时 chainIntact 必为 false，摘要仅作参考）
  let digest = '';
  for (const row of rangeRows) {
    if (!row.entryHash) continue;
    digest = sha256(`${digest}${CANONICAL_VERSION}:${row.entryHash}`);
  }

  const first = rangeRows.at(0);
  const last = rangeRows.at(-1);
  return {
    total: rangeRows.length,
    rangeDigest: digest,
    chainIntact: brokenAt.length === 0,
    firstAt: first ? first.createdAt.toISOString() : null,
    lastAt: last ? last.createdAt.toISOString() : null,
    firstSeq: familyRows.at(0)?.seq.toString() ?? null,
    brokenAt: [...new Set(brokenAt)].sort((a, b) => Number(a) - Number(b)),
  };
}

/** 导出用：按 seq 升序取筛选范围内全部行（至多 EXPORT_LIMIT 条）。 */
export async function findForExport(filter: AuditFilter) {
  return prisma.auditLog.findMany({
    where: buildWhere(filter),
    include: { actor: { select: { id: true, displayName: true, email: true } } },
    orderBy: { seq: 'asc' },
    take: EXPORT_LIMIT,
  });
}

/* ------------------------------------------------------------------ */
/* 敏感字段脱敏（输出层统一处理，库里的原始审计行不动）                 */
/* ------------------------------------------------------------------ */

const SENSITIVE_KEY_RE =
  /(password|passwd|pwd|secret|token|cookie|authorization|credential|密码|口令|令牌|密钥|邀请码)/i;

export const MASK = '***';

/**
 * 递归脱敏审计 diff：
 * - 键名命中密码/令牌/密钥等（含中文）→ 整体替换为 ***；
 * - 字符串值长得像邮箱 → 本地部分只留首字符；
 * - 字符串值长得像手机号 → 中间四位打码。
 */
export function redact(value: unknown, keyHint?: string): unknown {
  if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) return MASK;
  if (typeof value === 'string') return maskScalar(value);
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

const EMAIL_RE = /([^@\s])([^@\s]*)(@[^\s@]+)/g;
// 不锚定首尾：手机号可能嵌在一句话里（前后是中文/空格都算边界）
const PHONE_RE = /(?<!\d)(?:\+?\d{1,3}[- ]?)?(1\d{10})(?!\d)/g;

function maskScalar(s: string): string {
  let out = s.replace(EMAIL_RE, '$1***$3');
  out = out.replace(PHONE_RE, (_m, phone: string) => `${phone.slice(0, 3)}****${phone.slice(7)}`);
  return out;
}

/** IPv4 只保留前三段，IPv6 不回显明细。审计展示/导出统一调用。 */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.*`;
  if (ip.includes(':')) return 'ipv6:***';
  return ip;
}

/* ------------------------------------------------------------------ */
/* CSV 导出（调用方需先 redact；本函数只负责转义）                      */
/* ------------------------------------------------------------------ */

const CSV_COLUMNS = ['seq', 'createdAt', 'actorId', 'actorName', 'action', 'targetType', 'targetId', 'ip', 'diff'] as const;

export function toCsv(rows: Record<string, string>[]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => escape(row[c] ?? '')).join(','));
  }
  // UTF-8 BOM，保证 Excel/WPS 直接打开不乱码
  return '﻿' + lines.join('\n');
}
