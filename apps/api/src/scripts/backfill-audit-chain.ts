/**
 * 历史审计行哈希链回填。
 *
 * 运行时机：prisma migrate deploy 之后（package.json 的 db:deploy 自动串联），
 * 也可手动执行：pnpm --filter @heirloom/api audit:backfill-chain
 *
 * 幂等：已有 entry_hash 的行跳过；若发现某行哈希已填但与前链不衔接，
 * 从第一个断裂点起重新回填（只追加触发器允许 NULL→哈希 的一次性写入）。
 */
import { prisma } from '../db';
import { logger } from '../logger';
import { canonicalLine } from '../services/auditService';
import { createHash } from 'node:crypto';

const sha256 = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex');

async function main(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // 与运行时写入同一把事务级咨询锁，避免回填与新写入交错
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(872341)`;

      const rows = await tx.$queryRaw<
        {
          id: string;
          seq: bigint;
          family_id: string | null;
          actor_id: string;
          action: string;
          target_type: string;
          target_id: string | null;
          diff: unknown;
          ip: string | null;
          user_agent: string | null;
          created_at_text: string;
          prev_hash: string | null;
          entry_hash: string | null;
        }[]
      >`
        SELECT id, seq, family_id, actor_id, action, target_type, target_id,
               diff, ip, user_agent,
               to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_text,
               prev_hash, entry_hash
        FROM audit_logs
        ORDER BY seq ASC
      `;

      if (rows.length === 0) {
        logger.info('审计表为空，无需回填哈希链');
        return;
      }

      // 找到第一个需要回填的位置：entry_hash 为空，或 prev_hash 与计算链不衔接
      let startIdx = 0;
      let expectedPrev: string | null = null;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        if (row.entry_hash === null || row.prev_hash !== expectedPrev) {
          startIdx = i;
          break;
        }
        expectedPrev = row.entry_hash;
        startIdx = i + 1;
      }

      if (startIdx >= rows.length) {
        logger.info(`审计哈希链已是最新（${rows.length} 行），无需回填`);
        return;
      }

      // 回填从 startIdx 开始；它的 prev 是 startIdx-1 的 entry_hash
      let prevHash = startIdx > 0 ? rows[startIdx - 1]!.entry_hash : null;
      let filled = 0;

      for (let i = startIdx; i < rows.length; i += 1) {
        const row = rows[i]!;
        const hash = sha256(
          (prevHash ?? '') +
            canonicalLine({
              seq: row.seq,
              id: row.id,
              familyId: row.family_id,
              actorId: row.actor_id,
              action: row.action,
              targetType: row.target_type,
              targetId: row.target_id,
              diff: row.diff ?? null,
              ip: row.ip,
              userAgent: row.user_agent,
              createdAt: new Date(row.created_at_text),
            }),
        );

        // 只追加触发器允许「prev_hash/entry_hash 从 NULL 写入」这一次
        await tx.$executeRaw`
          UPDATE audit_logs
          SET prev_hash = ${prevHash}, entry_hash = ${hash}
          WHERE id = ${row.id} AND entry_hash IS NULL
        `;

        prevHash = hash;
        filled += 1;
      }

      logger.info({ total: rows.length, filled }, '审计哈希链回填完成');
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    logger.error({ err }, '审计哈希链回填失败');
    await prisma.$disconnect();
    process.exit(1);
  });
