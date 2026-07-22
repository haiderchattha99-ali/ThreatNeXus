-- Convert "User"."role" from TEXT to the "Role" enum without data loss.
--
-- Prisma's generated migration for this change is DROP COLUMN + ADD COLUMN,
-- which discards every existing user's role. It is replaced here with an
-- add / backfill / swap sequence that preserves legacy values.
--
-- A direct cast ("role"::"Role") is deliberately NOT used: the legacy column is
-- free-form TEXT with a lowercase 'analyst' default, so any row holding a value
-- outside the enum would abort the migration. The CASE below maps every input,
-- and anything unrecognised falls back to the least-privileged role (VIEWER)
-- rather than failing or inheriting elevated access.

-- 1. Add the enum column with the least-privilege default.
ALTER TABLE "User" ADD COLUMN "role_new" "Role" NOT NULL DEFAULT 'VIEWER';

-- 2. Backfill from the legacy TEXT column, case- and whitespace-insensitive.
--    NULL and empty values collapse to '' via COALESCE and land in ELSE.
UPDATE "User"
SET "role_new" = CASE UPPER(TRIM(COALESCE("role", '')))
    WHEN 'ADMIN'    THEN 'ADMIN'::"Role"
    WHEN 'ANALYST'  THEN 'ANALYST'::"Role"
    WHEN 'REVIEWER' THEN 'REVIEWER'::"Role"
    WHEN 'VIEWER'   THEN 'VIEWER'::"Role"
    -- Legacy/unknown values (user, member, basic, typos, NULL, '') -> VIEWER.
    ELSE 'VIEWER'::"Role"
END;

-- 3. Drop the legacy TEXT column and put the enum column in its place.
--    The NOT NULL constraint and the VIEWER default carry through the rename.
ALTER TABLE "User" DROP COLUMN "role";
ALTER TABLE "User" RENAME COLUMN "role_new" TO "role";
