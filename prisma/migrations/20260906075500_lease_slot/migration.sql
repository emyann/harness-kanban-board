-- Hand-written rather than generated, and the reason is the shape of the alternative.
--
-- Prisma emits `RedefineTables` — DROP and recreate — for a REQUIRED column added to `Lease`,
-- against a board a running daemon may be holding leases in. A nullable column is a plain
-- ADD COLUMN, and SQLite counts NULLs as distinct under a unique index, so leases claimed by an
-- older hkb keep working while every new one takes a slot no other live lease holds.

-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "slot" INTEGER;

-- AlterTable
ALTER TABLE "Lease" ADD COLUMN "slot" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Lease_slot_key" ON "Lease"("slot");
