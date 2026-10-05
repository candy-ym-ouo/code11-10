import { describe, expect, it } from 'vitest';
import { canonicalJson, computeEntryHash, GENESIS_HASH, rangeDigest } from './auditChain';

describe('审计哈希链', () => {
  it('规范化 JSON 对键顺序不敏感，结果可复现', () => {
    expect(canonicalJson({ b: 1, a: { y: 2, x: 3 } })).toBe(canonicalJson({ a: { x: 3, y: 2 }, b: 1 }));
    expect(canonicalJson([1, { b: 2, a: 3 }])).toBe(JSON.stringify([1, { a: 3, b: 2 }]));
  });

  it('同一条记录 + 同一 prevHash 反复计算得到同一 hash', () => {
    const entry = {
      seq: 42n,
      familyId: 'fam',
      actorId: 'user',
      action: 'item.update',
      targetType: 'item',
      targetId: 'i1',
      diff: { before: { title: '旧' }, after: { title: '新' } },
      ip: '127.0.0.1',
      userAgent: 'pytest',
      createdAt: '2026-10-05T01:02:03.000Z',
    };
    const h1 = computeEntryHash(entry, GENESIS_HASH);
    const h2 = computeEntryHash({ ...entry, diff: { after: { title: '新' }, before: { title: '旧' } } }, GENESIS_HASH);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
  });

  it('任何字段被改动都会导致 hash 变化', () => {
    const base = {
      seq: 1n,
      familyId: 'fam',
      actorId: 'user',
      action: 'item.create',
      targetType: 'item',
      targetId: null,
      diff: null,
      ip: null,
      userAgent: null,
      createdAt: '2026-10-05T00:00:00.000Z',
    };
    const h = computeEntryHash(base, GENESIS_HASH);
    expect(computeEntryHash({ ...base, action: 'item.delete' }, GENESIS_HASH)).not.toBe(h);
    expect(computeEntryHash({ ...base, ip: '10.0.0.1' }, GENESIS_HASH)).not.toBe(h);
    expect(computeEntryHash({ ...base, diff: { x: 1 } }, GENESIS_HASH)).not.toBe(h);
    expect(computeEntryHash(base, computeEntryHash(base, GENESIS_HASH))).not.toBe(h);
  });

  it('范围摘要对同一批 seq 稳定，对不同批次敏感', () => {
    const seqs = [3n, 4n, 5n];
    expect(rangeDigest(seqs)).toBe(rangeDigest([3, 4, 5]));
    expect(rangeDigest(seqs)).not.toBe(rangeDigest([3n, 4n]));
    expect(rangeDigest([])).toBe(GENESIS_HASH);
  });
});
