import { createHmac } from 'node:crypto';
import { config } from '../config';

/**
 * 审计哈希链：每条记录保存 prevHash（上一条 hash）与本条 hash，
 * hash = HMAC-SHA256(secret, 规范化后的本条内容 || prevHash)。
 *
 * - 篡改任何一个字段（包括 diff / IP / 时间）都会让本条 hash 失配；
 * - 删掉中间一条会让后续记录的 prevHash 断链；
 * - 全局 seq 单调递增，列表/导出都以它稳定排序与分页，
 *   同一时间范围 + 同一筛选反复计算，结果与摘要完全一致。
 */

/** 创世锚点：首条记录的 prevHash。 */
export const GENESIS_HASH = '0'.repeat(64);

function auditSecret(): string {
  // 单独配置优先；否则由 JWT_SECRET 固定派生，保证多实例 / 重启后一致。
  if (config.AUDIT_CHAIN_SECRET) return config.AUDIT_CHAIN_SECRET;
  return createHmac('sha256', config.JWT_SECRET).update('heirloom.audit-chain.v1').digest('hex');
}

/**
 * JSON 规范化：键按字典序排序、无多余空白，确保同一语义的内容
 * 在任何时候序列化出的字节流都一致（复算可重现的前提）。
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export interface ChainEntry {
  seq: bigint | number | string;
  familyId: string | null;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  /** 落库前的 diff（JSON 兼容对象）或读出的 jsonb。 */
  diff: unknown;
  ip: string | null;
  userAgent: string | null;
  /** ISO 字符串（落库统一由应用生成，复算时用存储值的 toISOString）。 */
  createdAt: string;
}

/** 计算单条审计记录的链式 hash。 */
export function computeEntryHash(entry: ChainEntry, prevHash: string): string {
  const payload = [
    String(entry.seq),
    entry.familyId ?? '',
    entry.actorId,
    entry.action,
    entry.targetType,
    entry.targetId ?? '',
    canonicalJson(entry.diff ?? null),
    entry.ip ?? '',
    entry.userAgent ?? '',
    entry.createdAt,
    prevHash,
  ].join('\n');
  return createHmac('sha256', auditSecret()).update(payload, 'utf8').digest('hex');
}

/**
 * 范围摘要：对「按 seq 升序的一组记录」做链式折叠，
 * 同一时间范围 / 同一筛选复算必然得到同一个值。
 * 导出 CSV 与校验接口返回同一个摘要，可相互印证。
 */
export function rangeDigest(seqs: readonly (bigint | number | string)[]): string {
  if (seqs.length === 0) return GENESIS_HASH;
  return createHmac('sha256', auditSecret())
    .update('heirloom.audit-range.v1\n')
    .update(seqs.map((s) => String(s)).join(','))
    .digest('hex');
}
