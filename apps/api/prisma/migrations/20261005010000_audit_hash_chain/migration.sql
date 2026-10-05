-- 审计日志增强：操作类型/成员组合筛选、稳定分页所需的全局递增序号，
-- 以及「哈希链 + 只追加」防篡改结构。
--
-- 链结构：每条日志的 entryHash = sha256(prevHash || 规范化行)，
-- 首条 prevHash 为 NULL（计算时以空串代替）。任何一条被改动/删除都会让
-- 其后所有哈希断裂；应用层在同一事务内取咨询锁、取链尾、写链，链不分叉。
--
-- 本迁移只负责结构（列、序列、索引、约束、只追加触发器）。历史行的哈希链
-- 回填复用运行时的 Node 规范化/哈希代码：
--   pnpm --filter @heirloom/api audit:backfill-chain
-- db:deploy 会在 prisma migrate deploy 之后自动执行它。
-- 新版本应用写入的每一行都带哈希；未回填的历史行会被 verify 接口标记为断裂。

-- 全局严格递增序号：分页游标的稳定锚点，也是回填时确定链顺序的依据
CREATE SEQUENCE "audit_logs_seq";

ALTER TABLE "audit_logs" ADD COLUMN "seq" BIGINT;
ALTER TABLE "audit_logs" ADD COLUMN "prev_hash" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "entry_hash" TEXT;

-- 序列归属 seq 列（DROP 表/列时自动清理）
ALTER SEQUENCE "audit_logs_seq" OWNED BY "audit_logs"."seq";

-- 回填顺序：同毫秒按 id 兜底，与应用层读取链尾的规则一致。
-- UPDATE 不支持 ORDER BY，用窗口函数先编号再关联更新。
WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at" ASC, "id" ASC) AS new_seq
  FROM "audit_logs"
)
UPDATE "audit_logs" l
SET "seq" = ordered.new_seq
FROM ordered
WHERE l."id" = ordered."id";

-- 让序列从「已回填最大 seq」之后继续：
-- 有数据时 is_called=true → 下次 nextval 返回 max+1；空表时 is_called=false（从 1 开始）。
SELECT setval(
  'audit_logs_seq',
  GREATEST((SELECT COALESCE(MAX("seq"), 1) FROM "audit_logs"), 1),
  (SELECT MAX("seq") IS NOT NULL FROM "audit_logs")
);

ALTER TABLE "audit_logs" ALTER COLUMN "seq" SET NOT NULL;
ALTER TABLE "audit_logs" ALTER COLUMN "seq" SET DEFAULT nextval('audit_logs_seq');
-- 对应 schema.prisma 的 seq @unique：全局序号绝不允许重复（非应用直插也 fail-closed）
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_seq_key" UNIQUE ("seq");

-- 家庭外键从 SET NULL 改为 RESTRICT：审计行一旦写入，其 family_id 就是哈希内容的
-- 一部分，级联置空会让该行哈希永远对不上。本系统家庭只做软删除（deletedAt），
-- 不存在硬删除路径；RESTRICT 同时兜底防止有人绕过应用直接 DROP 家庭抹掉归属。
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_family_id_fkey";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 筛选/分页主索引：家庭维度，按序号倒序
CREATE INDEX "audit_logs_family_id_seq_idx" ON "audit_logs"("family_id", "seq" DESC);

-- 只追加触发器：DELETE 一律拒绝。
-- UPDATE 只允许一种例外：一次性哈希回填（旧行 prev_hash/entry_hash 皆为 NULL，
-- 且仅这两列变化）。回填完成后所有行都有 entry_hash，该通道自然永久关闭。
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_logs 是只追加表，禁止删除';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."entry_hash" IS NULL
       AND OLD."prev_hash" IS NULL
       AND NEW."id" IS NOT DISTINCT FROM OLD."id"
       AND NEW."seq" IS NOT DISTINCT FROM OLD."seq"
       AND NEW."family_id" IS NOT DISTINCT FROM OLD."family_id"
       AND NEW."actor_id" IS NOT DISTINCT FROM OLD."actor_id"
       AND NEW."action" IS NOT DISTINCT FROM OLD."action"
       AND NEW."target_type" IS NOT DISTINCT FROM OLD."target_type"
       AND NEW."target_id" IS NOT DISTINCT FROM OLD."target_id"
       AND NEW."diff" IS NOT DISTINCT FROM OLD."diff"
       AND NEW."ip" IS NOT DISTINCT FROM OLD."ip"
       AND NEW."user_agent" IS NOT DISTINCT FROM OLD."user_agent"
       AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at" THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'audit_logs 是只追加表，禁止修改';
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only_trg
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
