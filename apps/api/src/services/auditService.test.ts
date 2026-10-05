import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalLine, maskIp, redact } from './auditService';

describe('审计规范化 JSON', () => {
  it('对象键按码点排序，与嵌套结构无关；分隔符对齐 PostgreSQL jsonb::text', () => {
    const a = canonicalJson({ b: 1, a: { z: 1, y: 2 }, c: [3, 2, 1] });
    const b = canonicalJson({ c: [3, 2, 1], a: { y: 2, z: 1 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a": {"y": 2, "z": 1}, "b": 1, "c": [3, 2, 1]}');
  });

  it('数组保序（顺序本身就是信息）', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1, 2, 3]');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  it('中文等多字节字符正常序列化（PG UTF8 下不转义非 ASCII）', () => {
    expect(canonicalJson({ 地点: '北京' })).toBe('{"地点": "北京"}');
  });

  it('undefined 字段被剔除，null 保留', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: null })).toBe('{"a": 1, "c": null}');
  });
});

describe('审计哈希链规范化行', () => {
  const base = {
    seq: 42n,
    id: 'abc123',
    familyId: 'fam1',
    actorId: 'user1',
    action: 'item.update',
    targetType: 'item',
    targetId: 'item1',
    diff: { before: { status: 'draft' }, after: { status: 'published' } },
    ip: '192.168.1.5',
    userAgent: 'curl/8',
    createdAt: new Date('2026-10-05T03:00:00.000Z'),
  };

  it('字段顺序与个数固定，seq 左补零到 20 位', () => {
    const line = canonicalLine(base);
    expect(line.split('\t')).toHaveLength(11);
    expect(line.startsWith('00000000000000000042\tabc123\tfam1\tuser1\titem.update')).toBe(true);
  });

  it('null 字段为空串占位，diff 为 null 时也是空串', () => {
    const line = canonicalLine({ ...base, familyId: null, targetId: null, diff: null, ip: null, userAgent: null });
    const cells = line.split('\t');
    expect(cells[2]).toBe('');
    expect(cells[6]).toBe('');
    expect(cells[7]).toBe('');
    expect(cells[8]).toBe('');
    expect(cells[9]).toBe('');
  });

  it('同一内容始终得到同一行（确定性）', () => {
    expect(canonicalLine(base)).toBe(canonicalLine({ ...base, diff: { after: { status: 'published' }, before: { status: 'draft' } } }));
  });

  it('任何字段变化都会改变规范化行', () => {
    expect(canonicalLine(base)).not.toBe(canonicalLine({ ...base, action: 'item.create' }));
    expect(canonicalLine(base)).not.toBe(canonicalLine({ ...base, seq: 43n }));
  });
});

describe('敏感字段脱敏', () => {
  it('密码/令牌/密钥类键整体打码（含中文键名）', () => {
    const out = redact({
      password: 'hunter2',
      newPassword: 'abc123456',
      tokenHash: 'xyz',
      refresh_token: 't',
      密码: '123456',
      邀请码: 'abcdef',
      title: '正常标题',
    }) as Record<string, string>;
    expect(out.password).toBe('***');
    expect(out.newPassword).toBe('***');
    expect(out.tokenHash).toBe('***');
    expect(out.refresh_token).toBe('***');
    expect(out.密码).toBe('***');
    expect(out.邀请码).toBe('***');
    expect(out.title).toBe('正常标题');
  });

  it('深层嵌套与数组内的敏感键也打码', () => {
    const out = redact({ before: { login: { secret: 's' } }, list: [{ cookie: 'c' }] }) as never;
    expect(out.before.login.secret).toBe('***');
    expect(out.list[0].cookie).toBe('***');
  });

  it('邮箱本地部分只留首字符，手机号中间四位打码', () => {
    expect(redact('alice@example.com')).toBe('a***@example.com');
    expect(redact({ email: 'zhang.san@family.cn' }).email).toBe('z***@family.cn');
    expect(redact('联系方式 13812345678 再见')).toBe('联系方式 138****5678 再见');
  });

  it('普通文本不受影响', () => {
    expect(redact('这是一把 1978 年的椅子')).toBe('这是一把 1978 年的椅子');
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
  });
});

describe('IP 脱敏', () => {
  it('IPv4 保留前三段', () => {
    expect(maskIp('192.168.1.5')).toBe('192.168.1.*');
    expect(maskIp('10.0.0.123')).toBe('10.0.0.*');
  });

  it('IPv6 不回显明细', () => {
    expect(maskIp('2001:db8::1')).toBe('ipv6:***');
  });

  it('空值透传', () => {
    expect(maskIp(null)).toBeNull();
  });
});
