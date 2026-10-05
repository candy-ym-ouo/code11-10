import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import { computeEntryHash, GENESIS_HASH, rangeDigest, type ChainEntry } from './auditChain';
import { maskIp, redactSensitive } from '../utils/auditRedact';
import { encodeCursor, decodeCursor } from '../utils/pagination';
import { badRequest } from '../http/errors';
import type { AuditExportQuery, AuditQuery } from '@heirloom/shared';

type Db = PrismaClient | Prisma.TransactionClient;

/** pg_advisory_xact_lock 用的固定锁号（任意 64 位常量，全实例一致即可）。 */
const CHAIN_LOCK_KEY = 892345;

export const AUDIT_EXPORT_MAX_ROWS = 10_000;

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

interface ChainRow {
  id: string;
  seq: bigint;
  familyId: string | null;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  diff: Prisma.JsonValue | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  prevHash: string | null;
  hash: string | null;
}

async function appendChainEntry(db: Db, input: AuditInput): Promise<void> {
  // 事务级咨询锁：同一时刻只有一个事务在追加哈希链。
  // 第二个事务会阻塞到第一个提交，因此读到的 last 必然包含刚提交的那条，
  // seq 与 prevHash 不会竞争错乱。
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`;
  const last = await db.auditLog.findFirst({
    orderBy: { seq: 'desc' },
    select: { seq: true, hash: true },
  });
  const seq = (last?.seq ?? 0n) + 1n;
  const prevHash = last?.hash ?? GENESIS_HASH;
  // JS Date 本身只有毫秒精度，与 TIMESTAMP(3) 一致；
  // 算哈希用 toISOString()，读出复算也用 toISOString()，两边字节相同。
  const createdAt = new Date();

  // 第一道脱敏：密码 / token / 密钥类内容永不落明文。
  const diff: Prisma.InputJsonValue | null =
    input.diff === undefined || input.diff === null ? null : (redactSensitive(input.diff) as Prisma.InputJsonValue);

  const entry: ChainEntry = {
    seq,
    familyId: input.familyId ?? null,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    diff: diff as unknown,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    createdAt: createdAt.toISOString(),
  };
  const hash = computeEntryHash(entry, prevHash);

  await db.auditLog.create({
    data: {
      familyId: entry.familyId,
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      diff: diff ?? undefined,
      ip: entry.ip,
      userAgent: entry.userAgent,
      createdAt,
      seq,
      prevHash,
      hash,
    },
  });
}

/**
 * 审计写入。所有写操作都必须在同一事务里调用它，保证「改了但没记录」不可能发生。
 * - 调用方已在事务中（传入 tx）：直接在该事务内加锁追加；
 * - 旁路场景（默认 prisma）：自己开一个事务，锁在事务提交前一直持有。
 */
export async function record(input: AuditInput, db: Db = prisma): Promise<void> {
  if (db === prisma) {
    await prisma.$transaction((tx) => appendChainEntry(tx, input));
  } else {
    await appendChainEntry(db, input);
  }
}

/** 审计失败不应掩盖主流程错误，用于无法纳入业务事务的旁路场景（登录等）。 */
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

/**
 * 启动时回填存量审计记录的 prev_hash / hash（迁移只补了 seq）。
 * 哈希依赖应用侧密钥，不能放进 SQL 迁移。幂等：只处理 hash IS NULL 的行。
 */
export async function backfillAuditChain(): Promise<number> {
  let filled = 0;
  for (;;) {
    const done = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`;
      const rows = await tx.auditLog.findMany({
        where: { hash: null, seq: { not: null } },
        orderBy: { seq: 'asc' },
        take: 500,
      });
      if (rows.length === 0) return 0;
      const firstSeq = rows[0]!.seq!;

      const predecessor = await tx.auditLog.findFirst({
        where: { seq: { lt: firstSeq } },
        orderBy: { seq: 'desc' },
        select: { hash: true },
      });
      let prevHash = predecessor?.hash ?? GENESIS_HASH;

      for (const row of rows) {
        const hash = computeEntryHash(
          {
            seq: row.seq!,
            familyId: row.familyId,
            actorId: row.actorId,
            action: row.action,
            targetType: row.targetType,
            targetId: row.targetId,
            diff: row.diff as unknown,
            ip: row.ip,
            userAgent: row.userAgent,
            createdAt: row.createdAt.toISOString(),
          },
          prevHash,
        );
        await tx.auditLog.update({ where: { id: row.id }, data: { prevHash, hash } });
        prevHash = hash;
      }
      return rows.length;
    });
    if (!done) break;
    filled += done;
  }
  if (filled > 0) logger.info({ rows: filled }, '审计哈希链回填完成');
  return filled;
}

// ---------------------------------------------------------------------------
// 查询：操作类型 + 成员 + 时间范围组合筛选，seq 游标分页
// ---------------------------------------------------------------------------

export interface AuditFilter {
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
}

function buildWhere(familyId: string, filter: AuditFilter): Prisma.AuditLogWhereInput {
  return {
    familyId,
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lte: new Date(filter.to) } : {}) } }
      : {}),
  };
}

function parseSeqCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  const raw = decodeCursor(cursor);
  if (!/^\d+$/.test(raw)) throw badRequest('分页游标无效');
  return BigInt(raw);
}

interface SerializedAuditLog {
  id: string;
  seq: string;
  action: string;
  targetType: string;
  targetId: string | null;
  diff: unknown;
  ip: string | null;
  createdAt: string;
  actor: { id: string; displayName: string; avatarColor: string };
}

export async function listAuditLogs(familyId: string, q: AuditQuery): Promise<{
  logs: SerializedAuditLog[];
  nextCursor: string | null;
  total: number;
}> {
  const where = buildWhere(familyId, q);
  const cursorSeq = parseSeqCursor(q.cursor);

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where: { ...where, seq: cursorSeq !== undefined ? { lt: cursorSeq } : { not: null } },
      orderBy: { seq: 'desc' },
      take: q.limit + 1,
      include: { actor: { select: { id: true, displayName: true, avatarColor: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page.at(-1);
  return {
    logs: page.map((row) => serializeRow(row as ChainRow & { actor: { id: string; displayName: string; avatarColor: string } })),
    nextCursor: hasMore && last?.seq != null ? encodeCursor(String(last.seq)) : null,
    total,
  };
}

function serializeRow(row: ChainRow & { actor: { id: string; displayName: string; avatarColor: string } }): SerializedAuditLog {
  return {
    id: row.id,
    seq: String(row.seq),
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    // 第二道脱敏：读出时再过一遍，兜底历史数据，并把 IP 去标识化。
    diff: redactSensitive(row.diff),
    ip: maskIp(row.ip),
    createdAt: row.createdAt.toISOString(),
    actor: row.actor,
  };
}

// ---------------------------------------------------------------------------
// 导出：与列表同一套谓词，时间范围内按 seq 升序产出 CSV（含哈希链三列）
// ---------------------------------------------------------------------------

export async function findAuditLogsForExport(
  familyId: string,
  filter: AuditFilter,
): Promise<(ChainRow & { actor: { displayName: string } })[]> {
  const rows = await prisma.auditLog.findMany({
    where: { ...buildWhere(familyId, filter), seq: { not: null } },
    orderBy: { seq: 'asc' },
    take: AUDIT_EXPORT_MAX_ROWS,
    include: { actor: { select: { displayName: true } } },
  });
  return rows as (ChainRow & { actor: { displayName: string } })[];
}

/** 防 CSV 公式注入：=、+、-、@、Tab、回车开头的单元格加单引号转义。 */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

export const AUDIT_CSV_HEADER = [
  '序号',
  '时间(UTC)',
  '操作类型',
  '操作类型说明',
  '成员',
  '成员ID',
  '对象类型',
  '对象ID',
  '变更内容(脱敏)',
  'IP(脱敏)',
  'User-Agent',
  '前序哈希',
  '本条哈希',
];

export function auditLogToCsvLine(
  row: ChainRow & { actor: { displayName: string } },
  actionLabels: Record<string, string>,
): string {
  return [
    row.seq.toString(),
    row.createdAt.toISOString(),
    row.action,
    actionLabels[row.action] ?? row.action,
    row.actor.displayName,
    row.actorId,
    row.targetType,
    row.targetId ?? '',
    JSON.stringify(redactSensitive(row.diff)),
    maskIp(row.ip) ?? '',
    row.userAgent ?? '',
    row.prevHash ?? '',
    row.hash ?? '',
  ]
    .map(csvCell)
    .join(',');
}

/** 一次筛选结果的范围摘要：同样的时间范围/操作/成员复算必得同值。 */
export function digestOfRows(rows: Pick<ChainRow, 'seq'>[]): string {
  return rangeDigest(rows.map((r) => r.seq));
}

// ---------------------------------------------------------------------------
// 完整性校验：重算范围内每一条的哈希，并沿全局哈希链检查断链 / 删除缺口
// ---------------------------------------------------------------------------

export interface AuditVerifyResult {
  scope: AuditFilter & { familyId: string };
  count: number;
  truncated: boolean;
  firstSeq: string | null;
  lastSeq: string | null;
  /** 范围内（按筛选命中的记录）的范围摘要。 */
  digest: string;
  /** 字段被改过：重算 hash 与落库 hash 不一致。 */
  tampered: string[];
  /** 链断：prev_hash 不等于全局前一条的 hash。 */
  brokenLinks: string[];
  /** 序号缺口：中间的记录被删除。 */
  missingSeqs: string[];
  intact: boolean;
}

export async function verifyAuditChain(familyId: string, filter: AuditExportQuery): Promise<AuditVerifyResult> {
  const scope = { ...filter, familyId };
  const scoped = await prisma.auditLog.findMany({
    where: { ...buildWhere(familyId, filter), seq: { not: null } },
    orderBy: { seq: 'asc' },
    take: AUDIT_EXPORT_MAX_ROWS + 1,
  });
  const truncated = scoped.length > AUDIT_EXPORT_MAX_ROWS;
  const hit = truncated ? scoped.slice(0, AUDIT_EXPORT_MAX_ROWS) : scoped;

  const result: AuditVerifyResult = {
    scope,
    count: hit.length,
    truncated,
    firstSeq: hit[0]?.seq != null ? String(hit[0].seq) : null,
    lastSeq: hit.at(-1)?.seq != null ? String(hit.at(-1)!.seq) : null,
    digest: digestOfRows(hit.filter((r) => r.seq != null).map((r) => ({ seq: r.seq! }))),
    tampered: [],
    brokenLinks: [],
    missingSeqs: [],
    intact: !truncated,
  };
  if (hit.length === 0) {
    result.intact = true;
    return result;
  }
  if (truncated) {
    // 范围过大无法给出可信结论，提示缩小时间范围。
    result.intact = false;
    return result;
  }

  // 取首条到末条之间的「全局」记录（哈希链是跨家庭的），在内存里复算。
  const firstSeq = hit[0]!.seq!;
  const lastSeq = hit.at(-1)!.seq!;
  const windowRows = await prisma.auditLog.findMany({
    where: { seq: { gte: firstSeq, lte: lastSeq } },
    orderBy: { seq: 'asc' },
  });
  const before = await prisma.auditLog.findFirst({
    where: { seq: { lt: firstSeq } },
    orderBy: { seq: 'desc' },
    select: { hash: true },
  });

  let prevHash = before?.hash ?? GENESIS_HASH;
  let expectedSeq = firstSeq;

  for (const row of windowRows) {
    if (row.seq == null) continue; // 理论上不会出现：迁移已为存量行补齐 seq
    while (expectedSeq < row.seq) {
      result.missingSeqs.push(String(expectedSeq));
      expectedSeq += 1n;
    }
    if (row.prevHash !== prevHash) result.brokenLinks.push(String(row.seq));
    const recomputed = computeEntryHash(
      {
        seq: row.seq,
        familyId: row.familyId,
        actorId: row.actorId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        diff: row.diff as unknown,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
      },
      row.prevHash ?? GENESIS_HASH,
    );
    if (recomputed !== row.hash) result.tampered.push(String(row.seq));
    prevHash = row.hash ?? GENESIS_HASH;
    expectedSeq = row.seq + 1n;
  }

  result.intact = result.tampered.length === 0 && result.brokenLinks.length === 0 && result.missingSeqs.length === 0;
  return result;
}
