import { Router } from 'express';
import {
  createFamilySchema,
  createInviteSchema,
  deleteFamilySchema,
  listAuditQuerySchema,
  updateFamilySchema,
  updateMemberSchema,
  verifyAuditSchema,
  type ListAuditQuery,
  type VerifyAuditQuery,
} from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser, requireAuth } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody, validateQuery, queryOf } from '../middleware/validation';
import * as familyService from '../services/familyService';
import { listMemberships } from '../services/authService';
import { timeline } from '../services/itemService';
import * as auditService from '../services/auditService';
import { prisma } from '../db';
import { badRequest } from '../http/errors';
import { decodeCursor, encodeCursor } from '../utils/pagination';

export const familiesRouter = Router();

familiesRouter.use(requireAuth);

familiesRouter.post(
  '/',
  writeLimiter,
  validateBody(createFamilySchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const family = await familyService.createFamily(user.id, req.body, clientMeta(req));
    res.status(201).json({ family });
  }),
);

familiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ memberships: await listMemberships(user.id) });
  }),
);

familiesRouter.get(
  '/:fid',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const family = await familyService.getFamilyDetail(ctx.familyId);
    const role = ctx.role;
    res.json({
      family: {
        id: family.id,
        name: family.name,
        description: family.description,
        defaultVisibility: family.defaultVisibility,
        allowViewerComment: family.allowViewerComment,
        createdAt: family.createdAt.toISOString(),
        counts: family._count,
      },
      myRole: role,
    });
  }),
);

familiesRouter.patch(
  '/:fid',
  requireFamily('family:update'),
  writeLimiter,
  validateBody(updateFamilySchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const family = await familyService.updateFamily(user.id, ctx.familyId, req.body, clientMeta(req));
    res.json({ family });
  }),
);

familiesRouter.delete(
  '/:fid',
  requireFamily('family:delete'),
  writeLimiter,
  validateBody(deleteFamilySchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await familyService.deleteFamily(user.id, ctx.familyId, req.body.confirmName, clientMeta(req));
    res.status(204).end();
  }),
);

familiesRouter.get(
  '/:fid/members',
  requireFamily('member:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ members: await familyService.listMembers(ctx.familyId, true) });
  }),
);

familiesRouter.patch(
  '/:fid/members/:userId',
  requireFamily('member:manage'),
  writeLimiter,
  validateBody(updateMemberSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const targetUserId = req.params.userId!;
    if (req.body.op === 'role') {
      await familyService.updateMemberRole(
        { id: user.id, role: ctx.role },
        ctx.familyId,
        targetUserId,
        req.body.role,
        clientMeta(req),
      );
    } else {
      await familyService.setMemberStatus(
        { id: user.id, role: ctx.role },
        ctx.familyId,
        targetUserId,
        req.body.op === 'disable' ? 'disabled' : 'active',
        clientMeta(req),
      );
    }
    res.json({ members: await familyService.listMembers(ctx.familyId, true) });
  }),
);

familiesRouter.delete(
  '/:fid/members/:userId',
  requireFamily('member:manage'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await familyService.removeMember({ id: user.id, role: ctx.role }, ctx.familyId, req.params.userId!, clientMeta(req));
    res.status(204).end();
  }),
);

familiesRouter.post(
  '/:fid/invites',
  requireFamily('invite:manage'),
  writeLimiter,
  validateBody(createInviteSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const invite = await familyService.createInvite(user.id, ctx.role, ctx.familyId, req.body, clientMeta(req));
    res.status(201).json({
      invite: {
        id: invite.id,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        maxUses: invite.maxUses,
        note: invite.note,
        code: invite.code,
        url: `/join/${invite.code}`,
      },
    });
  }),
);

familiesRouter.get(
  '/:fid/invites',
  requireFamily('invite:manage'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const invites = await familyService.listInvites(ctx.familyId);
    res.json({
      invites: invites.map((i) => ({
        id: i.id,
        role: i.role,
        note: i.note,
        expiresAt: i.expiresAt.toISOString(),
        maxUses: i.maxUses,
        usedCount: i.usedCount,
        revokedAt: i.revokedAt?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(),
      })),
    });
  }),
);

familiesRouter.delete(
  '/:fid/invites/:inviteId',
  requireFamily('invite:manage'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await familyService.revokeInvite(user.id, ctx.familyId, req.params.inviteId!, clientMeta(req));
    res.status(204).end();
  }),
);

familiesRouter.get(
  '/:fid/timeline',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json({ groups: await timeline(user.id, ctx) });
  }),
);

familiesRouter.get(
  '/:fid/stats',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const [byCategory, total, media, bytes, recent] = await Promise.all([
      prisma.item.groupBy({ by: ['category'], where: { familyId: ctx.familyId, status: { not: 'trashed' } }, _count: true }),
      prisma.item.count({ where: { familyId: ctx.familyId, status: { not: 'trashed' } } }),
      prisma.itemMedia.count({ where: { item: { familyId: ctx.familyId }, deletedAt: null } }),
      prisma.itemMedia.aggregate({ where: { item: { familyId: ctx.familyId }, deletedAt: null }, _sum: { byteSize: true } }),
      prisma.item.count({
        where: { familyId: ctx.familyId, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      }),
    ]);
    res.json({
      totalItems: total,
      totalMedia: media,
      totalBytes: Number(bytes._sum.byteSize ?? 0),
      recentItems: recent,
      byCategory: byCategory.map((c) => ({ category: c.category, count: c._count })),
    });
  }),
);

/** 审计查询参数 → 服务层过滤条件（游标是 seq 的 base64url 封装）。 */
function auditFilterOf(familyId: string, q: ListAuditQuery | VerifyAuditQuery): auditService.AuditFilter {
  return {
    familyId,
    actions: q.action,
    actorId: q.actorId,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
  };
}

function auditLogDto(l: {
  id: string;
  seq: bigint;
  action: string;
  targetType: string;
  targetId: string | null;
  diff: unknown;
  ip: string | null;
  createdAt: Date;
  actor: { id: string; displayName: string; avatarColor: string };
}) {
  return {
    id: l.id,
    seq: l.seq.toString(),
    action: l.action,
    targetType: l.targetType,
    targetId: l.targetId,
    diff: auditService.redact(l.diff),
    // IP 属于敏感网络信息：展示时末段打码
    ip: auditService.maskIp(l.ip),
    createdAt: l.createdAt.toISOString(),
    actor: l.actor,
  };
}

familiesRouter.get(
  '/:fid/audit-logs',
  requireFamily('audit:read'),
  validateQuery(listAuditQuerySchema),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const q = queryOf<ListAuditQuery>(req);
    let cursorSeq: bigint | undefined;
    if (q.cursor) {
      try {
        cursorSeq = BigInt(decodeCursor(q.cursor));
      } catch {
        throw badRequest('分页游标无效');
      }
      if (cursorSeq < 0n) throw badRequest('分页游标无效');
    }

    const filter = auditFilterOf(ctx.familyId, q);

    if (q.format === 'csv') {
      const { total, rangeDigest, chainIntact, firstAt, lastAt } = await auditService.verifyFamily(filter);
      if (total > auditService.EXPORT_LIMIT) {
        throw badRequest(`筛选结果 ${total} 条，超过单次导出上限 ${auditService.EXPORT_LIMIT} 条，请缩小时间范围分段导出`);
      }

      // 导出动作本身先留痕（记录本次导出的筛选条件与范围摘要，便于事后对账），
      // 再取数据行：这样导出的 CSV 里就能看到「这次导出」自身这条审计。
      // 留痕行不属于被导出的筛选范围，故文件头的 rangeDigest/total 是留痕前的值。
      await auditService.record({
        familyId: ctx.familyId,
        actorId: currentUser(req).id,
        action: 'audit.export',
        targetType: 'audit_log',
        diff: {
          format: 'csv',
          filters: { actions: filter.actions ?? null, actorId: filter.actorId ?? null, from: filter.from?.toISOString() ?? null, to: filter.to?.toISOString() ?? null },
          total,
          rangeDigest,
        },
        ...clientMeta(req),
      });

      const rows = await auditService.findForExport(filter);
      const header = [
        '# 家中物品来历册 · 审计日志导出',
        `# familyId=${ctx.familyId}`,
        `# exportedAt=${new Date().toISOString()}`,
        `# filters=${JSON.stringify({ actions: filter.actions ?? null, actorId: filter.actorId ?? null, from: filter.from?.toISOString() ?? null, to: filter.to?.toISOString() ?? null })}`,
        `# total=${total}`,
        `# firstAt=${firstAt ?? ''}`,
        `# lastAt=${lastAt ?? ''}`,
        `# rangeDigest=${rangeDigest}`,
        `# chainIntact=${chainIntact}`,
        '# 敏感字段（密码/令牌/密钥/邮箱/手机/IP末段）已脱敏；rangeDigest 可通过 GET audit-logs/verify 用相同条件复算',
      ].join('\n');

      const csv = auditService.toCsv(
        rows.map((r) => ({
          seq: r.seq.toString(),
          createdAt: r.createdAt.toISOString(),
          actorId: r.actor.id,
          actorName: r.actor.displayName,
          action: r.action,
          targetType: r.targetType,
          targetId: r.targetId ?? '',
          ip: auditService.maskIp(r.ip) ?? '',
          diff: JSON.stringify(auditService.redact(r.diff)),
        })),
      );

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-${ctx.familyId}-${new Date().toISOString().slice(0, 10)}.csv"`);
      // 复算凭据随头一起给出，方便脚本直接对账（同时也写在文件头注释里）
      res.setHeader('X-Audit-Range-Digest', rangeDigest);
      res.setHeader('X-Audit-Chain-Intact', String(chainIntact));
      res.send(`${header}\n${csv}`);
      return;
    }

    const { rows, nextCursorSeq } = await auditService.queryLogs({ ...filter, cursorSeq }, q.limit);
    res.json({
      logs: rows.map(auditLogDto),
      page: {
        limit: q.limit,
        nextCursor: nextCursorSeq ? encodeCursor(nextCursorSeq.toString()) : null,
      },
    });
  }),
);

familiesRouter.get(
  '/:fid/audit-logs/verify',
  requireFamily('audit:read'),
  validateQuery(verifyAuditSchema),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const q = queryOf<VerifyAuditQuery>(req);
    res.json({ verification: await auditService.verifyFamily(auditFilterOf(ctx.familyId, q)) });
  }),
);
