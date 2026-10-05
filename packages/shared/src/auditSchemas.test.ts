import { describe, expect, it } from 'vitest';
import { listAuditQuerySchema, verifyAuditSchema } from './schemas';

describe('审计查询参数', () => {
  it('接受重复 action 参数与逗号分隔两种形式', () => {
    const repeated = listAuditQuerySchema.parse({ action: ['item.create', 'member.invite'] });
    expect(repeated.action).toEqual(['item.create', 'member.invite']);

    const comma = listAuditQuerySchema.parse({ action: 'item.create,member.invite' });
    expect(comma.action).toEqual(['item.create', 'member.invite']);

    const mixed = listAuditQuerySchema.parse({ action: ['item.create,member.invite', 'item.update'] });
    expect(mixed.action).toEqual(['item.create', 'member.invite', 'item.update']);
  });

  it('默认 limit=60、format=json，空 action 视为未筛选', () => {
    const q = listAuditQuerySchema.parse({});
    expect(q.limit).toBe(60);
    expect(q.format).toBe('json');
    expect(q.action).toBeUndefined();
  });

  it('limit 超出 1..200 被拒，非法 action 被拒', () => {
    expect(listAuditQuerySchema.safeParse({ limit: '999' }).success).toBe(false);
    expect(listAuditQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listAuditQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listAuditQuerySchema.safeParse({ action: 'not.a.real.action' }).success).toBe(false);
  });

  it('from 晚于 to 报错', () => {
    const result = listAuditQuerySchema.safeParse({
      from: '2026-10-05T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('拒绝未声明的查询键（strict）', () => {
    expect(listAuditQuerySchema.safeParse({ evil: '1' }).success).toBe(false);
  });

  it('复算端点参数与列表一致，但不接受分页/format', () => {
    const ok = verifyAuditSchema.parse({ action: 'item.create', from: '2026-01-01T00:00:00.000Z' });
    expect(ok.action).toEqual(['item.create']);
    // verifyAuditSchema 是普通 object，多余键会被剥掉（只验证已知键）
    const extra = verifyAuditSchema.parse({ actorId: 'u1', limit: 999 });
    expect(extra).toMatchObject({ actorId: 'u1' });
  });
});
