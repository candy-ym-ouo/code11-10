import { describe, expect, it } from 'vitest';
import { maskIp, redactSensitive } from './auditRedact';

describe('审计敏感字段脱敏', () => {
  it('命中敏感键的值整体打码', () => {
    const out = redactSensitive({
      email: 'a@example.com',
      password: 'hunter2',
      nested: { tokenHash: 'x', displayName: '小明' },
      list: [{ JWT_SECRET: 's' }],
      passwordHash: null,
    }) as Record<string, unknown>;
    expect(out.password).toBe('***');
    expect((out.nested as Record<string, unknown>).tokenHash).toBe('***');
    expect((out.list as Record<string, unknown>[])[0]!.JWT_SECRET).toBe('***');
    expect(out.email).toBe('a@example.com');
    expect(out.passwordHash).toBeNull();
  });

  it('字符串里的 Bearer token 与 JWT 也会被抹掉', () => {
    const out = redactSensitive({
      header: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
      note: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0.InNpZ25hdHVyZXNpZ25hdHVyZQ',
      safe: 'nothing here',
    }) as Record<string, unknown>;
    expect(out.header).toBe('Bearer ***');
    expect(String(out.note)).not.toContain('eyJ');
    expect(out.safe).toBe('nothing here');
  });

  it('IP 只保留网段，抹掉主机位', () => {
    expect(maskIp('192.168.1.23')).toBe('192.168.*.*');
    expect(maskIp('10.0.0.1')).toBe('10.0.*.*');
    expect(maskIp('240e:123:456::1')).toBe('240e::****');
    expect(maskIp(null)).toBeNull();
  });
});
