-- Labels: the grouping key the board had none of.
--
-- One nullable column, so it is a plain ADD COLUMN against a board a daemon may be running in
-- rather than the RedefineTables a required column would emit — the same reason `Lease.slot` and
-- `Job.proposes` are nullable. It is the modelling answer too: an unlabelled Job has no labels,
-- which is a different fact from carrying an empty map, and only the null says so.
--
-- A string -> string map, the way Kubernetes labels an object, so `workflow=release` and
-- `step=draft` can both be true of one Job. Nothing in the controller reads it: `hkb ls --label`
-- selects on it and that is all it does (`src/labels.ts`).

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "labels" JSONB;
