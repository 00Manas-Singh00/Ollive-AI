-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('VIEWER', 'ANALYST', 'PROMPT_EDITOR', 'ADMIN');

-- AlterTable: add role column, migrate existing admins, drop isAdmin
ALTER TABLE "User" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'VIEWER';
UPDATE "User" SET "role" = 'ADMIN' WHERE "isAdmin" = true;
ALTER TABLE "User" DROP COLUMN "isAdmin";
