/**
 * 敏感字段脱敏。两道防线：
 * 1. 审计写入时对 diff 做一遍 redactSensitive，密码 / token / 哈希等绝不落明文；
 * 2. 读出与导出时再做一遍，兜底历史数据里可能残留的敏感键。
 *
 * IP 属于半敏感信息：库里保留完整地址供追责，列表与导出只给出去标识化的网段。
 */

const REDACTED = '***';

/** 命中即整体脱敏的键名（小写、子串匹配）。 */
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'authorization',
  'cookie',
  'csrf',
  'passwordhash',
  'tokenhash',
  'jwt',
  'apikey',
  'api_key',
  'privatekey',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}

/** 识别字符串值里的 Bearer token / JWT，避免它们藏在非敏感键的值中。 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;

function redactString(value: string): string {
  return value.replace(BEARER_RE, 'Bearer ***').replace(JWT_RE, '***');
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = val === undefined || val === null ? val : REDACTED;
      } else {
        out[key] = redactSensitive(val, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** IP 去标识化：保留网段用于定位来源归属，抹掉主机位。 */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.*.*`;
  // IPv6：保留第一段（通常即足够分辨来源网段），其余折叠。
  if (ip.includes(':')) {
    const head = ip.split(':')[0];
    return head ? `${head}::****` : '****';
  }
  return REDACTED;
}
