-- 审计日志：哈希链（防篡改）+ 稳定排序分页锚点
-- seq / prev_hash / hash 先以可空列加入：存量行的 seq 在本迁移里回填，
-- prev_hash/hash 由应用启动时的 backfillAuditChain() 按同一规范化算法补齐
-- （哈希依赖应用侧密钥，不能放在纯 SQL 迁移里）。

ALTER TABLE "audit_logs" ADD COLUMN "seq" BIGINT;
ALTER TABLE "audit_logs" ADD COLUMN "prev_hash" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "hash" TEXT;

-- 哈希链按 createdAt 的 UTC 时刻复算；旧列是不带时区的 TIMESTAMP，
-- 服务器/容器时区不同（本项目默认 TZ=Asia/Shanghai）会让读回值发生整点平移，
-- 改成 TIMESTAMPTZ 保证任何时区配置下写入-读回的时刻完全一致。
ALTER TABLE "audit_logs" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';

CREATE SEQUENCE IF NOT EXISTS "audit_logs_seq_seq";
ALTER SEQUENCE "audit_logs_seq_seq" OWNED BY "audit_logs"."seq";
ALTER TABLE "audit_logs" ALTER COLUMN "seq" SET DEFAULT nextval('audit_logs_seq_seq');

-- 按现有写入顺序回填全局序号；created_at 相同（或数据库时钟回拨）时用 id 兜底，
-- 保证序号唯一且与旧的列表顺序一致。
WITH ordered AS (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at" ASC, "id" ASC) AS rn
    FROM "audit_logs"
)
UPDATE "audit_logs" a SET "seq" = ordered.rn
FROM ordered
WHERE a."id" = ordered."id";

-- 把序列抬到当前最大序号（空表则停在 0，下一条得到 1），作为默认值兜底；
-- 应用写入时还会显式分配序号，双保险。
SELECT setval('audit_logs_seq_seq', GREATEST((SELECT COALESCE(MAX("seq"), 1) FROM "audit_logs"), 1), (SELECT COUNT(*) > 0 FROM "audit_logs"));

CREATE UNIQUE INDEX "audit_logs_seq_key" ON "audit_logs"("seq");

-- 列表/导出都按 (family, seq) 过滤排序，替换旧的 created_at 复合索引。
DROP INDEX "audit_logs_family_id_created_at_idx";
DROP INDEX "audit_logs_actor_id_created_at_idx";
CREATE INDEX "audit_logs_family_id_seq_idx" ON "audit_logs"("family_id", "seq");
CREATE INDEX "audit_logs_actor_id_seq_idx" ON "audit_logs"("actor_id", "seq");
