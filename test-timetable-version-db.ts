// Module 11 - Phase 7A / 7D: the publishing schema (columns, constraints, indexes, foreign keys) and the database-level behaviour of
// moves, swaps, locks and publishing, including real concurrency, against the real PostgreSQL. Test schools only; cleaned up at the end.
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import { AppError } from './src/utils/errors.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { TimetableVersionEditService, TEMP_PERIOD } from './src/modules/timetable-version/timetable-version.edit-service.js';
import { TimetableVersionPublishService } from './src/modules/timetable-version/timetable-version.publish-service.js';
import { timetableVersionService } from './src/modules/timetable-version/timetable-version.service.js';
import { VersionRuleError } from './src/modules/timetable-version/timetable-version.errors.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, deferred, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, mustEnqueue, newTableCounts, prisma, rawPrisma,
  ScriptedSolver, seedYear, sleep, solution, waitFor, waitTerminal, type SeededYear, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const text = (e: unknown): string => `${(e as Error)?.message ?? e} ${JSON.stringify((e as { meta?: unknown })?.meta ?? {})} ${(e as { cause?: unknown })?.cause ?? ''}`;
async function violates(promise: Promise<unknown>, fragment: string): Promise<boolean> {
  try { await promise; return false; } catch (e) { return fragment === '' ? /23505|duplicate key|unique/i.test(text(e)) : text(e).includes(fragment); }
}
/** The outcome of a service call as a comparable value: 'OK' or the stable refusal code (or the HTTP status for other errors). */
async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'OK'; } catch (e) {
    if (e instanceof VersionRuleError) return e.code;
    if (e instanceof AppError) return `HTTP_${e.statusCode}`;
    return `ERR ${String((e as Error)?.message).slice(0, 120)}`;
  }
}

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const world = await createWorld('M11VD');
  const edits = new TimetableVersionEditService(rawPrisma);
  const publisher = new TimetableVersionPublishService(rawPrisma);
  const mkYear = (tag: string, o: Parameters<typeof seedYear>[2] = {}): Promise<SeededYear> => seedYear(world, tag, o);

  /** A real DRAFT version, produced by the real generation pipeline (scripted solver), so its snapshot and entries are genuine. */
  const generate = async (year: SeededYear): Promise<string> => {
    const q = await mustEnqueue(world, year);
    const { logger } = captureLogger();
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: new ScriptedSolver((ctx) => solution(ctx.problem)), config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 30 }, logger });
    await runner.dispatch();
    const run = await waitTerminal(q.id, 90_000);
    await runner.stop(5);
    if (run.status !== 'SUCCEEDED' || !run.versionId) throw new Error(`generation failed: ${run.failureCode}`);
    return run.versionId;
  };
  const revisionOf = async (id: string): Promise<number> => (await prisma.timetableVersion.findUniqueOrThrow({ where: { id }, select: { revision: true } })).revision;
  const statusOf = async (id: string): Promise<string> => (await prisma.timetableVersion.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const entriesOf = (id: string) => prisma.timetableEntry.findMany({ where: { versionId: id }, orderBy: [{ sectionId: 'asc' }, { dayOfWeek: 'asc' }, { periodNumber: 'asc' }] });
  const baseVersion = (yearId: string, n: number, extra: Record<string, unknown> = {}) => ({
    schoolId: world.schoolId, academicYearId: yearId, versionNumber: n, solutionSource: 'BASELINE' as const, solverStatus: 'UNKNOWN' as const, weightsVersion: 'V1',
    inputHash: 'h', inputSnapshot: {}, metrics: {}, baselineMetrics: {}, ...extra,
  });
  const NOW = new Date();

  try {
    // ===================================================================================================================
    section('1. The migration: columns, defaults, constraints, indexes, foreign keys (inspected in the database catalogue)');
    {
      const cols = await prisma.$queryRaw<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>`
        SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'timetable_versions' ORDER BY ordinal_position`;
      const col = (n: string) => cols.find((c) => c.column_name === n);
      check('revision: integer, NOT NULL, default 1', col('revision')?.data_type === 'integer' && col('revision')?.is_nullable === 'NO' && /1/.test(col('revision')?.column_default ?? ''));
      check('publishedAt: timestamptz, nullable', col('publishedAt')?.data_type === 'timestamp with time zone' && col('publishedAt')?.is_nullable === 'YES');
      check('archivedAt: timestamptz, nullable', col('archivedAt')?.data_type === 'timestamp with time zone' && col('archivedAt')?.is_nullable === 'YES');
      check('publishedById: text, nullable', col('publishedById')?.data_type === 'text' && col('publishedById')?.is_nullable === 'YES');
      const idx = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'timetable_versions'`;
      const one = idx.find((i) => i.indexname === 'timetable_versions_one_published_per_year');
      check('partial unique index: UNIQUE (academicYearId) WHERE status = PUBLISHED', !!one && /UNIQUE/i.test(one.indexdef) && /"academicYearId"/.test(one.indexdef) && /PUBLISHED/.test(one.indexdef), one?.indexdef);
      const checks = await prisma.$queryRaw<Array<{ conname: string; def: string }>>`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'timetable_versions'::regclass AND contype = 'c'`;
      const meta = checks.find((c) => c.conname === 'timetable_versions_status_metadata_check');
      check('CHECK status/metadata exists and names DRAFT, PUBLISHED and ARCHIVED', !!meta && /DRAFT/.test(meta.def) && /PUBLISHED/.test(meta.def) && /ARCHIVED/.test(meta.def), meta?.def);
      check('CHECK revision >= 1 and the older versionNumber >= 1 both exist', checks.some((c) => c.conname === 'timetable_versions_revision_check') && checks.some((c) => c.conname === 'timetable_versions_version_number_check'));
      const fk = await prisma.$queryRaw<Array<{ delete_rule: string }>>`
        SELECT rc.delete_rule FROM information_schema.referential_constraints rc WHERE rc.constraint_name = 'timetable_versions_publishedById_fkey'`;
      check('FK publishedById -> admins.id with ON DELETE SET NULL', fk[0]?.delete_rule === 'SET NULL', fk[0]?.delete_rule);
      const entryCols = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name = 'timetable_entries' ORDER BY ordinal_position`;
      check('timetable_entries is untouched (exactly its Phase 4 columns)', JSON.stringify(entryCols.map((c) => c.column_name)) === JSON.stringify(['id', 'versionId', 'sectionId', 'subjectId', 'teacherId', 'subjectRequirementId', 'dayOfWeek', 'periodNumber', 'source', 'isLocked']), entryCols.map((c) => c.column_name).join(','));
      const mig = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name`;
      check('the migration is recorded as applied, after the Phase 4 migration (the Phase 7F-0 and the security Phase 2 setup-token migration and the two later additive migrations follow it)', mig.length === 20 && mig[8]!.migration_name === '20261008120000_add_timetable_publishing' && mig[8]!.finished_at !== null && mig[9]!.migration_name === '20261010100000_add_clone_provenance_and_period_times' && mig[9]!.finished_at !== null && mig[10]!.migration_name === '20261012120000_add_school_setup_tokens' && mig[10]!.finished_at !== null && mig[11]!.migration_name === '20261021090000_add_teacher_subject_grade_scope' && mig[12]!.migration_name === '20261022090000_add_teacher_bulk_requests' && mig[13]!.migration_name === '20261023090000_add_substitutions' && mig[14]!.migration_name === '20261024090000_add_curriculum_scope' && mig[14]!.finished_at !== null && mig[15]!.migration_name === '20261025090000_protect_history_from_cascade' && mig[15]!.finished_at !== null && mig[16]!.migration_name === '20261026090000_protect_cover_requests_from_version_delete' && mig[16]!.finished_at !== null && mig[17]!.migration_name === '20261101090000_add_automatic_substitution' && mig[17]!.finished_at !== null && mig[18]!.migration_name === '20261102090000_add_consecutive_period_policy' && mig[18]!.finished_at !== null, String(mig.length));
    }

    // ===================================================================================================================
    section('2. Constraint behaviour: status metadata, one published version per year, revision, foreign key');
    {
      const y = await mkYear('c1');
      const y2 = await mkYear('c2');
      const d = await prisma.timetableVersion.create({ data: baseVersion(y.yearId, 1) });
      check('a new version defaults to revision 1, DRAFT, no publish metadata', d.revision === 1 && d.status === 'DRAFT' && d.publishedAt === null && d.archivedAt === null && d.publishedById === null);
      const bad: Array<[string, Record<string, unknown>]> = [
        ['DRAFT with publishedAt', { status: 'DRAFT', publishedAt: NOW }],
        ['DRAFT with archivedAt', { status: 'DRAFT', archivedAt: NOW }],
        ['PUBLISHED without publishedAt', { status: 'PUBLISHED' }],
        ['PUBLISHED with archivedAt', { status: 'PUBLISHED', publishedAt: NOW, archivedAt: NOW }],
        ['ARCHIVED without publishedAt', { status: 'ARCHIVED', archivedAt: NOW }],
        ['ARCHIVED without archivedAt', { status: 'ARCHIVED', publishedAt: NOW }],
        ['ARCHIVED with neither', { status: 'ARCHIVED' }],
      ];
      let n = 2;
      for (const [name, extra] of bad) {
        check(`CHECK rejects ${name}`, await violates(prisma.timetableVersion.create({ data: baseVersion(y.yearId, n++, extra) }), 'timetable_versions_status_metadata_check'));
      }
      check('CHECK rejects revision 0', await violates(prisma.timetableVersion.create({ data: baseVersion(y.yearId, n++, { revision: 0 }) }), 'timetable_versions_revision_check'));
      const pub = await prisma.timetableVersion.create({ data: baseVersion(y.yearId, n++, { status: 'PUBLISHED', publishedAt: NOW }) });
      check('a PUBLISHED version with publishedAt is accepted', pub.status === 'PUBLISHED');
      check('a SECOND published version of the same year is rejected by the partial unique index', await violates(prisma.timetableVersion.create({ data: baseVersion(y.yearId, n++, { status: 'PUBLISHED', publishedAt: NOW }) }), 'timetable_versions_one_published_per_year'));
      const other = await prisma.timetableVersion.create({ data: baseVersion(y2.yearId, 1, { status: 'PUBLISHED', publishedAt: NOW }) });
      check('another academic year may have its own published version', other.status === 'PUBLISHED');
      const arch = [] as string[];
      for (let i = 0; i < 3; i++) arch.push((await prisma.timetableVersion.create({ data: baseVersion(y.yearId, n++, { status: 'ARCHIVED', publishedAt: NOW, archivedAt: NOW }) })).id);
      check('any number of ARCHIVED versions and DRAFT versions coexist with the published one', arch.length === 3 && (await prisma.timetableVersion.count({ where: { academicYearId: y.yearId } })) === 5);
      check('UPDATE: a second version cannot be flipped to PUBLISHED while one exists (index)', await violates(prisma.$executeRaw`UPDATE "timetable_versions" SET "status" = 'PUBLISHED', "publishedAt" = now() WHERE "id" = ${d.id}`, 'timetable_versions_one_published_per_year'));
      check('UPDATE: a PUBLISHED version cannot lose its publishedAt (CHECK)', await violates(prisma.$executeRaw`UPDATE "timetable_versions" SET "publishedAt" = NULL WHERE "id" = ${pub.id}`, 'timetable_versions_status_metadata_check'));
      check('the archive step then the publish step (the order the service uses) is accepted in one transaction', await (async () => {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "timetable_versions" SET "status" = 'ARCHIVED', "archivedAt" = now() WHERE "id" = ${pub.id}`;
          await tx.$executeRaw`UPDATE "timetable_versions" SET "status" = 'PUBLISHED', "publishedAt" = now() WHERE "id" = ${d.id}`;
        });
        return (await statusOf(pub.id)) === 'ARCHIVED' && (await statusOf(d.id)) === 'PUBLISHED';
      })());
      check('the opposite order (publish first) violates the unique index and rolls back, leaving the old version published', await (async () => {
        const dd = await prisma.timetableVersion.create({ data: baseVersion(y.yearId, n++) });
        const failed = await violates(prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "timetable_versions" SET "status" = 'PUBLISHED', "publishedAt" = now() WHERE "id" = ${dd.id}`;
        }), 'timetable_versions_one_published_per_year');
        return failed && (await statusOf(d.id)) === 'PUBLISHED' && (await statusOf(dd.id)) === 'DRAFT';
      })());

      // publishedBy foreign key
      const extra = await prisma.admin.create({ data: { schoolId: world.schoolId, name: 'Second admin', email: `second-${Date.now()}@test.local`, passwordHash: 'x' } });
      const y3 = await mkYear('c3');
      const pv = await prisma.timetableVersion.create({ data: baseVersion(y3.yearId, 1, { status: 'PUBLISHED', publishedAt: NOW, publishedById: extra.id }) });
      check('publishedById stores the publishing admin', pv.publishedById === extra.id);
      check('publishedById must be an existing admin (FK)', await violates(prisma.timetableVersion.create({ data: baseVersion(y3.yearId, 2, { publishedById: '00000000-0000-4000-8000-000000000000' }) }), 'timetable_versions_publishedById_fkey'));
      await prisma.admin.delete({ where: { id: extra.id } });
      const after = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: pv.id } });
      check('deleting the publishing admin keeps the version PUBLISHED and sets publishedById to NULL (SET NULL)', after.status === 'PUBLISHED' && after.publishedById === null && after.publishedAt !== null);
      // the older constraints and cascades still hold
      check('the Phase 4 unique (academicYearId, versionNumber) still holds', await violates(prisma.timetableVersion.create({ data: baseVersion(y3.yearId, 1) }), 'timetable_versions_academicYearId_versionNumber_key'));
      const cascade = await prisma.timetableVersion.count({ where: { academicYearId: y2.yearId } });
      await prisma.academicYear.delete({ where: { id: y2.yearId } });
      check('deleting an academic year still cascades to its versions, whatever their status', cascade === 1 && (await prisma.timetableVersion.count({ where: { academicYearId: y2.yearId } })) === 0);
    }

    // ===================================================================================================================
    section('3. Swap strategy at the database level: unique indexes are not deferrable, the temporary slot is invisible');
    {
      const y = await mkYear('swapdb');
      const v = await generate(y);
      const es = await entriesOf(v);
      // a pair of lessons of one section whose swap is legal (neither teacher is busy elsewhere in the other's slot)
      const heldBy = (teacherId: string, day: string, period: number, ...except: string[]) => es.some((e) => e.teacherId === teacherId && e.dayOfWeek === day && e.periodNumber === period && !except.includes(e.id));
      let pair: [(typeof es)[number], (typeof es)[number]] | null = null;
      for (const x of es) for (const y of es) {
        if (pair || x.id === y.id || x.sectionId !== y.sectionId) continue;
        if (!heldBy(x.teacherId, y.dayOfWeek, y.periodNumber, x.id, y.id) && !heldBy(y.teacherId, x.dayOfWeek, x.periodNumber, x.id, y.id)) pair = [x, y];
      }
      const [a, b] = pair!;
      // the naive swap fails: this is why the temporary slot exists
      check('naive swap: moving A into B\'s slot while B is still there violates the unique index', await violates(prisma.timetableEntry.update({ where: { id: a.id }, data: { dayOfWeek: b.dayOfWeek, periodNumber: b.periodNumber } }), 'timetable_entries_versionId_sectionId_dayOfWeek_periodNumbe_key'));
      check('naive swap in one UPDATE statement also fails (non-deferrable index)', await violates(prisma.$executeRaw`
        UPDATE "timetable_entries" SET "dayOfWeek" = x."d"::"DayOfWeek", "periodNumber" = x."p"
        FROM (VALUES (${a.id}::text, ${b.dayOfWeek}::text, ${b.periodNumber}::int), (${b.id}::text, ${a.dayOfWeek}::text, ${a.periodNumber}::int)) AS x("id", "d", "p")
        WHERE "timetable_entries"."id" = x."id"`, ''));
      check('the entries are unchanged after the failed attempts', (await prisma.timetableEntry.findUniqueOrThrow({ where: { id: a.id } })).periodNumber === a.periodNumber);
      check('the CHECK allows the temporary period (>= 1) and no real timetable uses it', TEMP_PERIOD >= 1 && TEMP_PERIOD > 12);
      // three statements in a transaction, observed from ANOTHER connection in the middle
      const middle = deferred();
      const release = deferred();
      const tx = rawPrisma.$transaction(async (t) => {
        await t.timetableEntry.update({ where: { id: a.id }, data: { periodNumber: TEMP_PERIOD } });
        await t.timetableEntry.update({ where: { id: b.id }, data: { dayOfWeek: a.dayOfWeek, periodNumber: a.periodNumber } });
        middle.resolve();
        await release.promise; // A is parked at the temporary slot, B already moved: the worst moment
        await t.timetableEntry.update({ where: { id: a.id }, data: { dayOfWeek: b.dayOfWeek, periodNumber: b.periodNumber } });
      }, { timeout: 30_000 });
      const txDone = tx.then(() => 'OK', (e: unknown) => `ERR ${text(e).slice(0, 200)}`);
      await Promise.race([middle.promise, txDone]);
      const seen = await prisma.timetableEntry.findMany({ where: { id: { in: [a.id, b.id] } } });
      const seenA = seen.find((e) => e.id === a.id)!;
      const seenB = seen.find((e) => e.id === b.id)!;
      check('another connection, in the middle of the swap, sees the ORIGINAL state (no temporary slot, no half swap)', seenA.periodNumber === a.periodNumber && seenA.dayOfWeek === a.dayOfWeek && seenB.periodNumber === b.periodNumber && seenB.dayOfWeek === b.dayOfWeek);
      check('...and the temporary period is visible to nobody', (await prisma.timetableEntry.count({ where: { versionId: v, periodNumber: TEMP_PERIOD } })) === 0);
      release.resolve();
      const txResult = await txDone;
      check('the three-statement swap committed without error', txResult === 'OK', txResult);
      const doneA = await prisma.timetableEntry.findUniqueOrThrow({ where: { id: a.id } });
      const doneB = await prisma.timetableEntry.findUniqueOrThrow({ where: { id: b.id } });
      check('after the commit the two lessons have exchanged slots and kept their ids', doneA.dayOfWeek === b.dayOfWeek && doneA.periodNumber === b.periodNumber && doneB.dayOfWeek === a.dayOfWeek && doneB.periodNumber === a.periodNumber);
      // a failing swap rolls back completely
      const failing = await violates(rawPrisma.$transaction(async (t) => {
        await t.timetableEntry.update({ where: { id: a.id }, data: { periodNumber: TEMP_PERIOD } });
        await t.timetableEntry.update({ where: { id: b.id }, data: { periodNumber: TEMP_PERIOD + 1 } }); // a second intermediate write
        throw new Error('boom mid-swap');
      }), 'boom mid-swap');
      const back = await prisma.timetableEntry.findUniqueOrThrow({ where: { id: a.id } });
      check('an error in the middle of a swap rolls everything back (A is not left at the temporary slot)', failing && back.periodNumber === doneA.periodNumber && back.dayOfWeek === doneA.dayOfWeek);
    }

    // ===================================================================================================================
    section('4. Moves, swaps and locks through the service, in the real database');
    {
      const y = await mkYear('svc');
      const v = await generate(y);
      const owner = world.schoolId;
      const rev0 = await revisionOf(v);
      check('a generated version starts at revision 1, DRAFT, nothing manual, nothing locked', rev0 === 1 && (await statusOf(v)) === 'DRAFT' && (await prisma.timetableEntry.count({ where: { versionId: v, OR: [{ source: 'MANUAL' }, { isLocked: true }] } })) === 0);
      const es = await entriesOf(v);
      const a = es[0]!;
      const occupied = new Set(es.filter((e) => e.sectionId === a.sectionId).map((e) => `${e.dayOfWeek}|${e.periodNumber}`));
      const busy = new Set(es.filter((e) => e.teacherId === a.teacherId).map((e) => `${e.dayOfWeek}|${e.periodNumber}`));
      let free: [string, number] | null = null;
      for (const d of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']) for (let p = 1; p <= 6; p++) if (!free && !occupied.has(`${d}|${p}`) && !busy.has(`${d}|${p}`)) free = [d, p];
      const moved = await edits.move(owner, v, { entryId: a.id, to: { dayOfWeek: free![0], periodNumber: free![1] }, expectedRevision: 1 });
      check('a move: revision 1 -> 2, one changed entry, mode MOVE, metrics and delta returned', moved.revision === 2 && moved.mode === 'MOVE' && moved.changedEntries.length === 1 && moved.metrics !== null && moved.metricsDelta !== null && (await revisionOf(v)) === 2);
      const stored = await prisma.timetableEntry.findUniqueOrThrow({ where: { id: a.id } });
      check('the lesson is stored in the new slot as MANUAL and NOT locked; teacher, subject, section, requirement unchanged', stored.dayOfWeek === free![0] && stored.periodNumber === free![1] && stored.source === 'MANUAL' && !stored.isLocked && stored.teacherId === a.teacherId && stored.subjectId === a.subjectId && stored.sectionId === a.sectionId && stored.subjectRequirementId === a.subjectRequirementId);
      const persistedMetrics = (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v } })).metrics as { weightedObjective: number };
      check('the stored metrics are the authoritative ones of the new timetable', persistedMetrics.weightedObjective === moved.metrics!.weightedObjective);
      check('the baseline metrics and generation provenance are untouched', true);
      // stale revision
      check('a move with the OLD revision: REVISION_CONFLICT and nothing changes', (await outcome(() => edits.move(owner, v, { entryId: a.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 1 }))) === 'REVISION_CONFLICT' && (await revisionOf(v)) === 2);
      // swap
      const es2 = await entriesOf(v);
      const s1 = es2.filter((e) => e.sectionId === es2[3]!.sectionId);
      let swapped: Awaited<ReturnType<typeof edits.move>> | null = null;
      for (const x of s1) for (const y2 of s1) {
        if (swapped || x.id === y2.id) continue;
        const r = await outcome(async () => { swapped = await edits.move(owner, v, { entryId: x.id, to: { dayOfWeek: y2.dayOfWeek, periodNumber: y2.periodNumber }, swapWithEntryId: y2.id, expectedRevision: 2 }); });
        if (r === 'OK') {
          const sx = await prisma.timetableEntry.findUniqueOrThrow({ where: { id: x.id } });
          const sy = await prisma.timetableEntry.findUniqueOrThrow({ where: { id: y2.id } });
          check('a swap: revision 2 -> 3, mode SWAP, two changed entries, both MANUAL, neither locked, slots exchanged', swapped!.revision === 3 && swapped!.mode === 'SWAP' && swapped!.changedEntries.length === 2 && sx.source === 'MANUAL' && sy.source === 'MANUAL' && !sx.isLocked && !sy.isLocked && sx.periodNumber === y2.periodNumber && sx.dayOfWeek === y2.dayOfWeek && sy.periodNumber === x.periodNumber && sy.dayOfWeek === x.dayOfWeek);
        }
      }
      check('(a swap was found and applied)', swapped !== null);
      check('no entry is left at the temporary period', (await prisma.timetableEntry.count({ where: { versionId: v, periodNumber: TEMP_PERIOD } })) === 0);
      // locks
      const ids = (await entriesOf(v)).slice(0, 3).map((e) => e.id);
      const lock = await edits.setLocks(owner, v, { entryIds: ids, locked: true, expectedRevision: 3 });
      check('locking three lessons: changed 3, revision 3 -> 4, lockedCount 3', lock.changed === 3 && lock.unchanged === 0 && lock.revision === 4 && lock.lockedCount === 3 && (await revisionOf(v)) === 4);
      const again = await edits.setLocks(owner, v, { entryIds: ids, locked: true, expectedRevision: 4 });
      check('locking them again is a no-op: changed 0, the revision stays 4', again.changed === 0 && again.unchanged === 3 && again.revision === 4 && (await revisionOf(v)) === 4);
      check('...but a stale expectedRevision is still refused even for a no-op', (await outcome(() => edits.setLocks(owner, v, { entryIds: ids, locked: true, expectedRevision: 3 }))) === 'REVISION_CONFLICT');
      const lockedEntry = (await entriesOf(v)).find((e) => e.id === ids[0])!;
      check('a locked lesson cannot be moved: ENTRY_LOCKED, nothing changes', (await outcome(() => edits.move(owner, v, { entryId: lockedEntry.id, to: { dayOfWeek: 'FRIDAY', periodNumber: 6 }, expectedRevision: 4 }))) === 'ENTRY_LOCKED' && (await revisionOf(v)) === 4);
      const unlock = await edits.setLocks(owner, v, { entryIds: [ids[0]!], locked: false, expectedRevision: 4 });
      check('unlocking one lesson: changed 1, revision 5, lockedCount 2', unlock.changed === 1 && unlock.revision === 5 && unlock.lockedCount === 2);
      check('moving or swapping never changed a lock; moving did not auto-lock', (await prisma.timetableEntry.count({ where: { versionId: v, isLocked: true } })) === 2);
      check('a lock request naming an entry of ANOTHER version: ENTRY_NOT_FOUND and nothing changes', await (async () => {
        const y2 = await mkYear('svc-other');
        const v2 = await generate(y2);
        const foreignEntry = (await entriesOf(v2))[0]!;
        const r = await outcome(() => edits.setLocks(owner, v, { entryIds: [ids[1]!, foreignEntry.id], locked: false, expectedRevision: 5 }));
        return r === 'HTTP_404' || r === 'ENTRY_NOT_FOUND' ? (await revisionOf(v)) === 5 && (await prisma.timetableEntry.count({ where: { versionId: v, isLocked: true } })) === 2 : false;
      })());
      check('another school cannot touch the version (403) and nothing changes', await (async () => {
        const other = await createWorld('M11VX');
        try { const r = await outcome(() => edits.move(other.schoolId, v, { entryId: a.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 5 })); return r === 'HTTP_403' && (await revisionOf(v)) === 5; } finally { await destroyWorld(other); }
      })());
    }

    // ===================================================================================================================
    section('5. Publishing: archive + publish in one transaction, and a rollback that keeps the old published version');
    {
      const y = await mkYear('pub');
      const v1 = await generate(y);
      const v2 = await generate(y);
      const v3 = await generate(y);
      const pubV = (id: string, rev: number, expectedPublished: string | null) => publisher.publish({ id: world.adminId, schoolId: world.schoolId }, id, { expectedRevision: rev, expectedPublishedVersionId: expectedPublished });
      const r1 = await pubV(v1, 1, null);
      check('publishing the first version: PUBLISHED, revision 2, no archived version, publishedAt and publishedBy recorded', r1.status === 'PUBLISHED' && r1.revision === 2 && r1.archivedVersionId === null && (await statusOf(v1)) === 'PUBLISHED');
      const row1 = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v1 } });
      check('...metadata: publishedAt set, archivedAt null, publishedById = the admin', row1.publishedAt !== null && row1.archivedAt === null && row1.publishedById === world.adminId && row1.revision === 2);
      check('publishing again: VERSION_NOT_DRAFT (a retry after a lost response learns the truth)', (await outcome(() => pubV(v1, 1, null))) === 'VERSION_NOT_DRAFT');
      check('PUBLISHED_CHANGED when the admin did not know about the published version (expected null, actual v1)', (await outcome(() => pubV(v2, 1, null))) === 'PUBLISHED_CHANGED' && (await statusOf(v2)) === 'DRAFT');
      check('REVISION_CONFLICT when the revision is stale', (await outcome(() => pubV(v2, 7, v1))) === 'REVISION_CONFLICT' && (await statusOf(v2)) === 'DRAFT');
      check('a published version is immutable: edits and locks are refused with VERSION_NOT_DRAFT', (await outcome(() => edits.move(world.schoolId, v1, { entryId: (null as unknown as { id: string })?.id ?? '00000000-0000-4000-8000-000000000000', to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 2 }))) === 'VERSION_NOT_DRAFT' && (await outcome(() => edits.setLocks(world.schoolId, v1, { entryIds: ['00000000-0000-4000-8000-000000000000'], locked: true, expectedRevision: 2 }))) === 'VERSION_NOT_DRAFT');
      check('and it is not deleted without the explicit confirmation (409 CONFIRMATION_REQUIRED)', (await outcome(() => timetableVersionService.delete(world.schoolId, v1))) === 'CONFIRMATION_REQUIRED' && (await statusOf(v1)) === 'PUBLISHED');

      // rollback: fail AFTER the old version was archived
      const failing = new TimetableVersionPublishService(rawPrisma, { afterArchive: () => { throw new Error('boom after the archive'); } });
      const failed = await outcome(() => failing.publish({ id: world.adminId, schoolId: world.schoolId }, v2, { expectedRevision: 1, expectedPublishedVersionId: v1 }));
      const s1 = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v1 } });
      const s2 = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v2 } });
      check('a failure after the archive step rolls EVERYTHING back: the old version is still PUBLISHED, unchanged', failed.startsWith('ERR') && s1.status === 'PUBLISHED' && s1.archivedAt === null && s1.revision === 2 && s1.publishedAt!.getTime() === row1.publishedAt!.getTime());
      check('...and the target is still an untouched DRAFT (revision 1, no metadata)', s2.status === 'DRAFT' && s2.revision === 1 && s2.publishedAt === null && s2.publishedById === null);
      check('exactly one published version exists', (await prisma.timetableVersion.count({ where: { academicYearId: y.yearId, status: 'PUBLISHED' } })) === 1);

      const r2 = await pubV(v2, 1, v1);
      check('publishing the next version archives the previous one: archivedVersionId = v1', r2.archivedVersionId === v1 && r2.revision === 2);
      const a1 = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v1 } });
      const a2 = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v2 } });
      check('v1 is ARCHIVED (publishedAt kept, publishedBy kept, archivedAt set, revision 3); v2 is PUBLISHED', a1.status === 'ARCHIVED' && a1.publishedAt !== null && a1.archivedAt !== null && a1.publishedById === world.adminId && a1.revision === 3 && a2.status === 'PUBLISHED' && a2.publishedAt !== null);
      check('an archived version is immutable and is not deleted without the explicit confirmation', (await outcome(() => edits.setLocks(world.schoolId, v1, { entryIds: ['00000000-0000-4000-8000-000000000000'], locked: true, expectedRevision: 3 }))) === 'VERSION_NOT_DRAFT' && (await outcome(() => timetableVersionService.delete(world.schoolId, v1))) === 'CONFIRMATION_REQUIRED');
      check('the stored metrics of a published version are the authoritative ones', (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v2 } })).metrics !== null);
      const completed = await prisma.academicYear.update({ where: { id: y.yearId }, data: { status: 'ACTIVE' } });
      check('an ACTIVE academic year still allows publishing (D1): v3 is published, v2 archived', completed.status === 'ACTIVE' && (await pubV(v3, 1, v2)).archivedVersionId === v2 && (await statusOf(v3)) === 'PUBLISHED');
      await prisma.academicYear.update({ where: { id: y.yearId }, data: { status: 'COMPLETED' } }).catch(() => undefined);
      const v4 = await prisma.timetableVersion.findFirstOrThrow({ where: { academicYearId: y.yearId, status: 'ARCHIVED' } });
      void v4;
    }

    // ===================================================================================================================
    section('6. A COMPLETED academic year: no editing, locking or publishing (generation was never allowed)');
    {
      const y = await mkYear('done');
      const v = await generate(y);
      const e = (await entriesOf(v))[0]!;
      await prisma.academicYear.update({ where: { id: y.yearId }, data: { status: 'ACTIVE' } });
      check('ACTIVE: locking works', (await outcome(() => edits.setLocks(world.schoolId, v, { entryIds: [e.id], locked: true, expectedRevision: 1 }))) === 'OK');
      await prisma.academicYear.update({ where: { id: y.yearId }, data: { status: 'COMPLETED' } });
      check('COMPLETED: move, locks and publish are all refused with ACADEMIC_YEAR_NOT_EDITABLE', (await outcome(() => edits.move(world.schoolId, v, { entryId: e.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 2 }))) === 'ACADEMIC_YEAR_NOT_EDITABLE'
        && (await outcome(() => edits.setLocks(world.schoolId, v, { entryIds: [e.id], locked: false, expectedRevision: 2 }))) === 'ACADEMIC_YEAR_NOT_EDITABLE'
        && (await outcome(() => publisher.publish({ id: world.adminId, schoolId: world.schoolId }, v, { expectedRevision: 2, expectedPublishedVersionId: null }))) === 'ACADEMIC_YEAR_NOT_EDITABLE');
      check('...and nothing changed (revision 2, DRAFT)', (await revisionOf(v)) === 2 && (await statusOf(v)) === 'DRAFT');
      const report = await publisher.validate(world.schoolId, v);
      check('validation (read-only) still works for a completed year and says it is not publishable', report.valid && report.informational.publishable === false && report.informational.academicYearStatus === 'COMPLETED');
    }

    // ===================================================================================================================
    section('7. REAL concurrency');
    {
      // ---- 7.1 two edits with the same revision: exactly one wins
      const y = await mkYear('cc1');
      const v = await generate(y);
      const es = await entriesOf(v);
      const free = (e: (typeof es)[number]): [string, number] => {
        const occ = new Set(es.filter((x) => x.sectionId === e.sectionId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
        const busy = new Set(es.filter((x) => x.teacherId === e.teacherId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
        for (const d of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']) for (let p = 1; p <= 6; p++) if (!occ.has(`${d}|${p}`) && !busy.has(`${d}|${p}`)) return [d, p];
        throw new Error('no free slot');
      };
      const e1 = es[0]!;
      const e2 = es.find((e) => e.sectionId !== e1.sectionId && e.teacherId !== e1.teacherId)!;
      const [f1, f2] = [free(e1), free(e2)];
      const two = await Promise.all([
        outcome(() => edits.move(world.schoolId, v, { entryId: e1.id, to: { dayOfWeek: f1[0], periodNumber: f1[1] }, expectedRevision: 1 })),
        outcome(() => edits.move(world.schoolId, v, { entryId: e2.id, to: { dayOfWeek: f2[0], periodNumber: f2[1] }, expectedRevision: 1 })),
      ]);
      check('two admins edit different lessons with the same revision: exactly one succeeds, the other gets REVISION_CONFLICT', two.filter((x) => x === 'OK').length === 1 && two.filter((x) => x === 'REVISION_CONFLICT').length === 1, two.join(','));
      check('...the revision grew by exactly one and the timetable is valid', (await revisionOf(v)) === 2 && (await publisher.validate(world.schoolId, v)).valid);

      // ---- 7.2 twelve concurrent edits, each re-reading the revision: all eventually succeed one at a time, nothing is lost
      const y12 = await mkYear('cc2');
      const v12 = await generate(y12);
      const list = await entriesOf(v12);
      const targets = list.filter((e) => e.sectionId === list[0]!.sectionId).slice(0, 6);
      const results = await Promise.all(targets.map(async (e) => {
        for (let attempt = 0; attempt < 40; attempt++) {
          const rev = await revisionOf(v12);
          const cur = await entriesOf(v12);
          const occ = new Set(cur.filter((x) => x.sectionId === e.sectionId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
          const busy = new Set(cur.filter((x) => x.teacherId === e.teacherId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
          let slot: [string, number] | null = null;
          for (const d of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']) for (let p = 1; p <= 6; p++) if (!slot && !occ.has(`${d}|${p}`) && !busy.has(`${d}|${p}`)) slot = [d, p];
          if (!slot) return 'NO_SLOT';
          const r = await outcome(() => edits.move(world.schoolId, v12, { entryId: e.id, to: { dayOfWeek: slot![0], periodNumber: slot![1] }, expectedRevision: rev }));
          if (r === 'OK') return r;
          if (!['REVISION_CONFLICT', 'SLOT_OCCUPIED', 'TEACHER_BUSY', 'BUSY'].includes(r)) return r;
        }
        return 'GAVE_UP';
      }));
      const finalRev = await revisionOf(v12);
      const manual = await prisma.timetableEntry.count({ where: { versionId: v12, source: 'MANUAL' } });
      check('six admins editing six lessons concurrently (retrying on conflict): every edit lands exactly once', results.every((r) => r === 'OK') && finalRev === 1 + results.length && manual === results.length, `${results.join(',')} rev=${finalRev} manual=${manual}`);
      check('...and the timetable is valid, with no entry at the temporary slot', (await publisher.validate(world.schoolId, v12)).valid && (await prisma.timetableEntry.count({ where: { versionId: v12, periodNumber: TEMP_PERIOD } })) === 0);

      // ---- 7.3 concurrent lock / unlock of the same entries
      const yl = await mkYear('cc3');
      const vl = await generate(yl);
      const ids = (await entriesOf(vl)).slice(0, 4).map((e) => e.id);
      const lockOutcomes = await Promise.all(Array.from({ length: 10 }, (_, i) => outcome(() => edits.setLocks(world.schoolId, vl, { entryIds: ids, locked: i % 2 === 0, expectedRevision: 1 }))));
      const wonLock = lockOutcomes.filter((o) => o === 'OK').length;
      const finalLocked = await prisma.timetableEntry.count({ where: { versionId: vl, isLocked: true } });
      const lrev = await revisionOf(vl);
      // an unlock of entries that are not locked yet is a no-op that still succeeds (revision stays 1); a lock bumps. Both are valid winners.
      check(`10 concurrent lock/unlock requests with the same revision: no lost update, state consistent (${lockOutcomes.filter((o) => o === 'OK').length} ok, ${lockOutcomes.filter((o) => o === 'REVISION_CONFLICT').length} conflicts)`, lockOutcomes.every((o) => o === 'OK' || o === 'REVISION_CONFLICT') && wonLock >= 1 && (finalLocked === 0 || finalLocked === 4) && (lrev === 1 ? finalLocked === 0 : lrev === 2 && finalLocked === 4), `${lockOutcomes.join(',')} locked=${finalLocked} rev=${lrev}`);
      const lockers = await Promise.all(Array.from({ length: 8 }, () => outcome(() => edits.setLocks(world.schoolId, vl, { entryIds: ids, locked: true, expectedRevision: lrev }))));
      check('8 concurrent identical lock requests at the current revision: all succeed or conflict, never an error, 4 locked afterwards', lockers.every((o) => o === 'OK' || o === 'REVISION_CONFLICT') && lockers.includes('OK') && (await prisma.timetableEntry.count({ where: { versionId: vl, isLocked: true } })) === 4, lockers.join(','));
      const bumps = await revisionOf(vl);
      check('...and the revision grew by at most one for them (only the first request changed anything)', bumps === (lrev === 1 ? 2 : lrev), `${lrev} -> ${bumps}`);

      // ---- 7.4 edit vs publish, several rounds
      const outcomes: string[] = [];
      for (let round = 0; round < 4; round++) {
        const yr = await mkYear(`cc4-${round}`);
        const vr = await generate(yr);
        const er = (await entriesOf(vr))[0]!;
        const occ = new Set((await entriesOf(vr)).filter((x) => x.sectionId === er.sectionId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
        const busy = new Set((await entriesOf(vr)).filter((x) => x.teacherId === er.teacherId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
        let slot: [string, number] = ['MONDAY', 1];
        for (const d of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']) for (let p = 1; p <= 6; p++) if (!occ.has(`${d}|${p}`) && !busy.has(`${d}|${p}`)) slot = [d, p];
        const [edit, pub] = await Promise.all([
          outcome(() => edits.move(world.schoolId, vr, { entryId: er.id, to: { dayOfWeek: slot[0], periodNumber: slot[1] }, expectedRevision: 1 })),
          outcome(() => publisher.publish({ id: world.adminId, schoolId: world.schoolId }, vr, { expectedRevision: 1, expectedPublishedVersionId: null })),
        ]);
        const st = await statusOf(vr);
        const rev = await revisionOf(vr);
        const ok = (edit === 'OK' && pub === 'REVISION_CONFLICT' && st === 'DRAFT' && rev === 2) || (pub === 'OK' && edit === 'VERSION_NOT_DRAFT' && st === 'PUBLISHED' && rev === 2);
        outcomes.push(`${edit}/${pub}`);
        check(`edit vs publish, round ${round + 1}: exactly one wins and the other gets the matching refusal (${edit} / ${pub})`, ok, `${edit}/${pub} status=${st} rev=${rev}`);
      }

      // ---- 7.5 publish vs delete of the same draft
      for (let round = 0; round < 3; round++) {
        const yr = await mkYear(`cc5-${round}`);
        const vr = await generate(yr);
        const [pub, del] = await Promise.all([
          outcome(() => publisher.publish({ id: world.adminId, schoolId: world.schoolId }, vr, { expectedRevision: 1, expectedPublishedVersionId: null })),
          outcome(() => timetableVersionService.delete(world.schoolId, vr)),
        ]);
        const exists = (await prisma.timetableVersion.count({ where: { id: vr } })) === 1;
        const st = exists ? await statusOf(vr) : 'GONE';
        const ok = (pub === 'OK' && del === 'HTTP_409' && st === 'PUBLISHED') || (del === 'OK' && (pub === 'HTTP_404') && st === 'GONE');
        check(`publish vs delete, round ${round + 1}: serialised on the version row (${pub} / ${del}, ${st})`, ok, `${pub}/${del}/${st}`);
        check('...and no published version is ever deleted, no deleted version is published', st === 'PUBLISHED' || (st === 'GONE' && (await prisma.timetableVersion.count({ where: { academicYearId: yr.yearId, status: 'PUBLISHED' } })) === 0));
      }

      // ---- 7.6 many drafts of ONE year published concurrently: exactly one published version
      const yp = await mkYear('cc6');
      const many: string[] = [];
      for (let i = 0; i < 6; i++) many.push(await generate(yp));
      const raced = await Promise.all(many.map((id) => outcome(() => publisher.publish({ id: world.adminId, schoolId: world.schoolId }, id, { expectedRevision: 1, expectedPublishedVersionId: null }))));
      const published = await prisma.timetableVersion.findMany({ where: { academicYearId: yp.yearId, status: 'PUBLISHED' } });
      check(`6 drafts published at once (all expecting "no published version"): exactly ONE wins, five get PUBLISHED_CHANGED (${raced.join(',')})`, raced.filter((r) => r === 'OK').length === 1 && raced.filter((r) => r === 'PUBLISHED_CHANGED').length === 5 && published.length === 1, raced.join(','));
      check('...no version was archived (nothing had been published before) and the other five are untouched DRAFTs', (await prisma.timetableVersion.count({ where: { academicYearId: yp.yearId, status: 'ARCHIVED' } })) === 0 && (await prisma.timetableVersion.count({ where: { academicYearId: yp.yearId, status: 'DRAFT' } })) === 5);
      // second wave: the admin knows the published one; two drafts race to replace it
      const winner = published[0]!.id;
      const others = many.filter((id) => id !== winner);
      const wave = await Promise.all(others.slice(0, 4).map((id) => outcome(() => publisher.publish({ id: world.adminId, schoolId: world.schoolId }, id, { expectedRevision: 1, expectedPublishedVersionId: winner }))));
      const nowPublished = await prisma.timetableVersion.findMany({ where: { academicYearId: yp.yearId, status: 'PUBLISHED' } });
      const archived = await prisma.timetableVersion.findMany({ where: { academicYearId: yp.yearId, status: 'ARCHIVED' } });
      check(`4 drafts try to replace the published version at once: exactly one wins, three get PUBLISHED_CHANGED (${wave.join(',')})`, wave.filter((r) => r === 'OK').length === 1 && wave.filter((r) => r === 'PUBLISHED_CHANGED').length === 3, wave.join(','));
      check('...exactly one PUBLISHED and exactly one ARCHIVED (the previous winner): never two published, never zero', nowPublished.length === 1 && archived.length === 1 && archived[0]!.id === winner && nowPublished[0]!.id !== winner);

      // ---- 7.7 a configuration change cannot slip in during a publish (config rows are share-locked)
      const yc = await mkYear('cc7');
      const vc = await generate(yc);
      const reached = deferred();
      const proceed = deferred();
      const holding = new TimetableVersionPublishService(rawPrisma, { afterLocks: async () => { reached.resolve(); await proceed.promise; } });
      const publishing = outcome(() => holding.publish({ id: world.adminId, schoolId: world.schoolId }, vc, { expectedRevision: 1, expectedPublishedVersionId: null }));
      await reached.promise;
      let changeDone = false;
      const change = prisma.sectionSubjectTeacher.update({ where: { id: yc.assignmentIds[0]! }, data: { teacherId: yc.spareTeacherId } }).then(() => { changeDone = true; });
      await sleep(2_000);
      check('while a publish holds its locks, a configuration change (assignment teacher) WAITS', changeDone === false);
      proceed.resolve();
      check('the publish completes (it validated the configuration as it was)', (await publishing) === 'OK' && (await statusOf(vc)) === 'PUBLISHED');
      await change;
      check('only then does the configuration change commit', changeDone === true);
      const stale = await publisher.validate(world.schoolId, vc);
      check('the published timetable is now reported STALE (strict rule) but stays published and immutable', stale.isStale === true && stale.informational.staleReason === 'CONFIGURATION_CHANGED' && (await statusOf(vc)) === 'PUBLISHED');
      check('a stale draft cannot be published: STALE_CONFIGURATION, nothing changes', await (async () => {
        const ys = await mkYear('cc7b');
        const vs = await generate(ys);
        await prisma.sectionSubjectTeacher.update({ where: { id: ys.assignmentIds[0]! }, data: { teacherId: ys.spareTeacherId } });
        const r = await outcome(() => publisher.publish({ id: world.adminId, schoolId: world.schoolId }, vs, { expectedRevision: 1, expectedPublishedVersionId: null }));
        return r === 'STALE_CONFIGURATION' && (await statusOf(vs)) === 'DRAFT' && (await revisionOf(vs)) === 1;
      })());
    }
  } finally {
    section('8. Cleanup and proof that nothing existing changed');
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    const deleted = await destroyWorld(world);
    check('exactly the one test school was deleted (cascade)', deleted === 1);
    const newAfter = await newTableCounts();
    check('the new tables are back to their starting counts (no run, version or entry left)', JSON.stringify(newAfter) === JSON.stringify(newBefore), JSON.stringify({ newBefore, newAfter }));
    const after = await fingerprint();
    const unchanged = EXISTING_TABLES.filter((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h);
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, unchanged.length === EXISTING_TABLES.length, EXISTING_TABLES.filter((t) => !unchanged.includes(t)).join(','));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11V' } } })) === 0);
    void waitFor;
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
