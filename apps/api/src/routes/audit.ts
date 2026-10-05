import { Router } from 'express';
import {
  auditExportQuerySchema,
  auditQuerySchema,
  AUDIT_ACTION_LABELS,
  type AuditExportQuery,
  type AuditQuery,
} from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { exportLimiter } from '../middleware/rateLimit';
import { queryOf, validateQuery } from '../middleware/validation';
import {
  AUDIT_CSV_HEADER,
  AUDIT_EXPORT_MAX_ROWS,
  auditLogToCsvLine,
  digestOfRows,
  findAuditLogsForExport,
  listAuditLogs,
  recordSoft,
  verifyAuditChain,
} from '../services/auditService';

export const auditRouter = Router({ mergeParams: true });

/**
 * 审计日志：操作类型 + 成员 + 时间范围组合筛选，seq 游标分页。
 * 列表是纯追加的历史，任何角色都不能修改或删除（哈希链在服务层校验）。
 */
auditRouter.get(
  '/',
  requireFamily('audit:read'),
  validateQuery(auditQuerySchema),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const query = queryOf<AuditQuery>(req);
    res.json(await listAuditLogs(ctx.familyId, query));
  }),
);

/**
 * 导出审计日志 CSV：与列表共用同一套筛选谓词，
 * 同样的时间范围反复导出得到同样的行、同样的范围摘要（响应头 X-Audit-Digest）。
 * 每行附带 seq / prevHash / hash，离线即可核对是否被篡改。
 */
auditRouter.get(
  '/export',
  requireFamily('audit:read'),
  exportLimiter,
  validateQuery(auditExportQuerySchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const filter = queryOf<AuditExportQuery>(req);
    const rows = await findAuditLogsForExport(ctx.familyId, filter);
    const digest = digestOfRows(rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${ctx.familyId}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('X-Audit-Count', String(rows.length));
    res.setHeader('X-Audit-Digest', digest);
    res.setHeader('X-Audit-Truncated', rows.length >= AUDIT_EXPORT_MAX_ROWS ? '1' : '0');
    // Excel 识别 UTF-8 中文需要 BOM
    res.write('﻿');
    res.write(AUDIT_CSV_HEADER.join(','));
    res.write('\n');
    for (const row of rows) {
      res.write(auditLogToCsvLine(row, AUDIT_ACTION_LABELS));
      res.write('\n');
    }
    res.end();

    await recordSoft({
      familyId: ctx.familyId,
      actorId: user.id,
      action: 'audit.export',
      targetType: 'audit_logs',
      diff: {
        action: filter.action ?? null,
        actorId: filter.actorId ?? null,
        from: filter.from ?? null,
        to: filter.to ?? null,
        rows: rows.length,
        digest,
      },
      ...clientMeta(req),
    });
  }),
);

/**
 * 完整性校验：对时间范围内的审计记录重算哈希链，
 * 返回被篡改 / 断链 / 删除缺口的序号，以及该范围的摘要。
 */
auditRouter.get(
  '/verify',
  requireFamily('audit:read'),
  validateQuery(auditExportQuerySchema),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const filter = queryOf<AuditExportQuery>(req);
    res.json({ result: await verifyAuditChain(ctx.familyId, filter) });
  }),
);
