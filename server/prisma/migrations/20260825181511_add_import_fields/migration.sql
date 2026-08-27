-- AlterTable
ALTER TABLE "workspace_threads" ADD COLUMN "externalId" TEXT;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "importedFrom" TEXT;
