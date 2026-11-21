// Module 11 - Phase 7C / 7D: the HTTP API for reviewing, editing, locking, validating and publishing timetable versions.
// buildApp() + app.inject() (real routes, real auth middleware, real sessions from the production login service), real database,
// real generation pipeline (and real Python for the end-to-end flow). Test schools only; cleaned up at the end.
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import './test-fixtures/test-security-env.js'; // a test-only COOKIE_SECRET (production mode refuses the placeholder in .env)
import { spawnSync } from 'node:child_process';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { REPO_ROOT, resolveSolverClientConfig, SubprocessSolverClient, type SolverClient } from './src/modules/timetable-generation/timetable-generation.solver-client.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, newTableCounts, prisma, rawPrisma, ScriptedSolver, seedYear,
  solution, waitFor, waitTerminal, type SeededYear, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const PASSWORD = 'Ver#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const TIGHT = { sections: 3, subjects: [6, 6, 6, 6, 5] };
const solverProcesses = (): string[] => spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(`${REPO_ROOT}/solver/main.py`) && !l.includes('ps -axo'));

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('M11VA');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('M11VA');
  const worlds = [worldA, worldB];
  const runners: GenerationRunner[] = [];

  interface Reply { status: number; body: Record<string, any>; headers: Record<string, any>; text: string }
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie: string | null, payload?: unknown): Promise<Reply> => {
    const res = await app.inject({ method, url, ...(cookie ? { headers: { cookie: `session_token=${cookie}` } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Record<string, any> = {};
    try { body = JSON.parse(res.body); } catch { /* not JSON */ }
    return { status: res.statusCode, body, headers: res.headers, text: res.body };
  };
  const sessionFor = async (world: World, adminId = world.adminId): Promise<string> => {
    const admin = await prisma.admin.findUniqueOrThrow({ where: { id: adminId } });
    await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    return (await adminService.loginAdmin({ schoolId: world.schoolId, email: admin.email, password: PASSWORD })).sessionToken;
  };
  const tokA = await sessionFor(worldA);
  const tokB = await sessionFor(worldB);
  const second = await prisma.admin.create({ data: { schoolId: worldA.schoolId, name: 'Second admin', email: `second-${Date.now()}@test.local`, passwordHash: 'x' } });
  const tokA2 = await sessionFor(worldA, second.id);

  let forwardTo: GenerationRunner | null = null;
  registerGenerationRunner({ trigger: () => forwardTo?.trigger() });
  const makeRunner = (solver: SolverClient): GenerationRunner => {
    const { logger } = captureLogger();
    const r = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 30 }, logger });
    runners.push(r);
    return r;
  };
  const scripted = makeRunner(new ScriptedSolver((ctx) => solution(ctx.problem)));
  forwardTo = scripted;
  scripted.start();
  const mkYear = (world: World, tag: string, o: Parameters<typeof seedYear>[2] = {}): Promise<SeededYear> => seedYear(world, tag, o);
  /** Generate a DRAFT through the real API and runner. */
  const generate = async (tok: string, year: SeededYear): Promise<string> => {
    const r = await call('POST', '/api/timetable-generations', tok, { academicYearId: year.yearId });
    if (r.status !== 202) throw new Error(`generation rejected: ${r.text}`);
    const run = await waitTerminal(r.body.data.generationRunId, 90_000);
    if (run.status !== 'SUCCEEDED') throw new Error(`generation failed: ${run.failureCode}`);
    return run.versionId!;
  };
  const getV = async (tok: string, id: string) => (await call('GET', `/api/timetable-versions/${id}`, tok)).body.data;
  const freeSlot = (entries: any[], e: any): [string, number] | null => {
    const occ = new Set(entries.filter((x) => x.sectionId === e.sectionId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
    const busy = new Set(entries.filter((x) => x.teacherId === e.teacherId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
    for (const d of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']) for (let p = 1; p <= 6; p++) if (!occ.has(`${d}|${p}`) && !busy.has(`${d}|${p}`)) return [d, p];
    return null;
  };
  const move = (tok: string, v: string, body: unknown) => call('POST', `/api/timetable-versions/${v}/moves`, tok, body);
  const locks = (tok: string, v: string, body: unknown) => call('PUT', `/api/timetable-versions/${v}/locks`, tok, body);
  const validate = (tok: string, v: string) => call('GET', `/api/timetable-versions/${v}/validation`, tok);
  const publish = (tok: string, v: string, body: unknown) => call('POST', `/api/timetable-versions/${v}/publish`, tok, body);
  const codeOf = (r: Reply): string | undefined => r.body?.data?.code;

  try {
    // ===================================================================================================================
    section('1. Authentication: every new endpoint requires a session');
    {
      const y = await mkYear(worldA, 'auth');
      const v = await generate(tokA, y);
      const e = (await getV(tokA, v)).entries[0];
      const calls: Array<[string, () => Promise<Reply>]> = [
        ['POST moves', () => move(null, v, { entryId: e.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 1 })],
        ['PUT locks', () => locks(null, v, { entryIds: [e.id], locked: true, expectedRevision: 1 })],
        ['GET validation', () => validate(null, v)],
        ['POST publish', () => publish(null, v, { expectedRevision: 1, expectedPublishedVersionId: null })],
      ];
      for (const [name, fn] of calls) {
        const r = await fn();
        check(`${name} without a session: 401 in the standard envelope`, r.status === 401 && r.body.success === false);
      }
      const bad = await move('garbage-token', v, { entryId: e.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 1 });
      check('an invalid session token: 401', bad.status === 401);
      const after = await getV(tokA, v);
      check('nothing changed (revision 1, no lock, no manual lesson, DRAFT)', after.revision === 1 && after.lockedCount === 0 && after.manualEditCount === 0 && after.status === 'DRAFT');
    }

    // ===================================================================================================================
    section('2. GET /timetable-versions/:id and the list: the new fields');
    {
      const y = await mkYear(worldA, 'view');
      const v = await generate(tokA, y);
      const d = await getV(tokA, v);
      check('detail: revision 1, publishedAt/archivedAt null, lockedCount 0, manualEditCount 0', d.revision === 1 && d.publishedAt === null && d.archivedAt === null && d.lockedCount === 0 && d.manualEditCount === 0);
      check('detail: all Phase 6 fields are still there', ['id', 'academicYearId', 'versionNumber', 'status', 'solutionSource', 'solverStatus', 'optimal', 'weightsVersion', 'inputHash', 'metrics', 'baselineMetrics', 'entryCount', 'createdAt', 'updatedAt', 'solverDiagnostics', 'entries'].every((k) => k in d));
      check('detail: entries carry source GENERATED and isLocked false', d.entries.every((e: any) => e.source === 'GENERATED' && e.isLocked === false));
      const lst = (await call('GET', `/api/timetable-versions?academicYearId=${y.yearId}`, tokA)).body.data;
      check('list: the same new fields on every summary', lst.length === 1 && lst[0].revision === 1 && lst[0].publishedAt === null && lst[0].archivedAt === null && lst[0].lockedCount === 0 && lst[0].manualEditCount === 0 && lst[0].entries === undefined);
      const txt = JSON.stringify(d);
      check('no lease owner, process id, stderr or path in the version', !/leaseOwner|stderrTail|"pid"|\/Users\//.test(txt));
    }

    // ===================================================================================================================
    section('3. POST /moves: validation (400)');
    {
      const y = await mkYear(worldA, 'mv400');
      const v = await generate(tokA, y);
      const e = (await getV(tokA, v)).entries[0];
      const ok = { entryId: e.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 1 };
      const cases: Array<[string, unknown, string]> = [
        ['no body', undefined, ''],
        ['missing entryId', { to: ok.to, expectedRevision: 1 }, 'entryId'],
        ['malformed entryId', { ...ok, entryId: 'nope' }, 'entryId'],
        ['missing to', { entryId: e.id, expectedRevision: 1 }, 'to'],
        ['to is not an object', { ...ok, to: 'MONDAY' }, 'to'],
        ['missing expectedRevision', { entryId: e.id, to: ok.to }, 'expectedRevision'],
        ['expectedRevision 0', { ...ok, expectedRevision: 0 }, 'expectedRevision'],
        ['expectedRevision as a string', { ...ok, expectedRevision: '1' }, 'expectedRevision'],
        ['expectedRevision fractional', { ...ok, expectedRevision: 1.5 }, 'expectedRevision'],
        ['periodNumber fractional', { ...ok, to: { dayOfWeek: 'MONDAY', periodNumber: 1.5 } }, 'to.periodNumber'],
        ['periodNumber as a string', { ...ok, to: { dayOfWeek: 'MONDAY', periodNumber: '1' } }, 'to.periodNumber'],
        ['malformed swapWithEntryId', { ...ok, swapWithEntryId: 'x' }, 'swapWithEntryId'],
        ['a teacher field (D7: rejected)', { ...ok, teacherId: UUID0 }, ''],
        ['a subject field', { ...ok, subjectId: UUID0 }, ''],
        ['a section field', { ...ok, sectionId: UUID0 }, ''],
        ['an assignment field', { ...ok, assignmentId: UUID0 }, ''],
        ['an unknown field inside to', { ...ok, to: { dayOfWeek: 'MONDAY', periodNumber: 1, teacherId: UUID0 } }, ''],
        ['a client schoolId', { ...ok, schoolId: worldB.schoolId }, ''],
      ];
      for (const [name, payload, field] of cases) {
        const r = payload === undefined ? (await app.inject({ method: 'POST', url: `/api/timetable-versions/${v}/moves`, headers: { cookie: `session_token=${tokA}` } })) : null;
        const reply = r ? { status: r.statusCode, body: JSON.parse(r.body) } : await move(tokA, v, payload);
        const errs = reply.body.errors as Record<string, string[]> | undefined;
        check(`${name}: 400 in the standard validation envelope`, reply.status === 400 && reply.body.success === false && (field === '' || (errs !== undefined && Object.keys(errs).some((k) => k.startsWith(field)))), `${reply.status} ${JSON.stringify(reply.body).slice(0, 160)}`);
      }
      check('a malformed version id in the path: 400', (await move(tokA, 'not-a-uuid', ok)).status === 400);
      const after = await getV(tokA, v);
      check('no rejected request changed anything', after.revision === 1 && after.manualEditCount === 0);
    }

    // ===================================================================================================================
    section('4. POST /moves: move, swap and every refusal code');
    {
      const y = await mkYear(worldA, 'mv');
      const v = await generate(tokA, y);
      let d = await getV(tokA, v);
      const a = d.entries[0];
      const slot = freeSlot(d.entries, a)!;
      const countsBefore = JSON.stringify(d.entries.map((e: any) => `${e.sectionId}|${e.subjectRequirementId}|${e.teacherId}`).sort());
      const r = await move(tokA, v, { entryId: a.id, to: { dayOfWeek: slot[0], periodNumber: slot[1] }, expectedRevision: 1 });
      check('move to a free slot: 200, mode MOVE, revision 2', r.status === 200 && r.body.data.mode === 'MOVE' && r.body.data.revision === 2, r.text.slice(0, 200));
      check('the response carries the changed lesson (MANUAL, not locked), metrics, metricsDelta, counts', r.body.data.changedEntries.length === 1 && r.body.data.changedEntries[0].source === 'MANUAL' && r.body.data.changedEntries[0].isLocked === false && r.body.data.changedEntries[0].dayOfWeek === slot[0] && r.body.data.metrics.weightsVersion === 'V1' && typeof r.body.data.metricsDelta.weightedObjective === 'number' && r.body.data.manualEditCount === 1 && r.body.data.lockedCount === 0);
      d = await getV(tokA, v);
      check('GET shows revision 2, one manual edit, the lesson in its new slot', d.revision === 2 && d.manualEditCount === 1 && d.entries.find((e: any) => e.id === a.id).dayOfWeek === slot[0] && d.entries.find((e: any) => e.id === a.id).periodNumber === slot[1]);
      check('the stored metrics follow the edit', d.metrics.weightedObjective === r.body.data.metrics.weightedObjective);
      check('no lesson was added or removed: the multiset of (section, requirement, teacher) is identical, 36 lessons', d.entries.length === 36 && JSON.stringify(d.entries.map((e: any) => `${e.sectionId}|${e.subjectRequirementId}|${e.teacherId}`).sort()) === countsBefore);

      const stale = await move(tokA, v, { entryId: a.id, to: { dayOfWeek: 'FRIDAY', periodNumber: 6 }, expectedRevision: 1 });
      check('the old revision: 409 REVISION_CONFLICT with the current revision in data', stale.status === 409 && codeOf(stale) === 'REVISION_CONFLICT' && stale.body.data.revision === 2, stale.text);
      const noop = await move(tokA, v, { entryId: a.id, to: { dayOfWeek: slot[0], periodNumber: slot[1] }, expectedRevision: 2 });
      check('moving a lesson to the slot it is already in: 400 INVALID_MOVE', noop.status === 400 && codeOf(noop) === 'INVALID_MOVE');
      const badSlots: Array<[string, any]> = [['Saturday (not a working day)', { dayOfWeek: 'SATURDAY', periodNumber: 1 }], ['an unknown day', { dayOfWeek: 'FUNDAY', periodNumber: 1 }], ['period 0', { dayOfWeek: 'MONDAY', periodNumber: 0 }], ['period 99', { dayOfWeek: 'MONDAY', periodNumber: 99 }], ['a negative period', { dayOfWeek: 'MONDAY', periodNumber: -3 }]];
      for (const [name, to] of badSlots) {
        const x = await move(tokA, v, { entryId: a.id, to, expectedRevision: 2 });
        check(`${name}: 400 INVALID_SLOT`, x.status === 400 && codeOf(x) === 'INVALID_SLOT', `${x.status} ${x.text.slice(0, 120)}`);
      }
      const sameSec = d.entries.find((e: any) => e.sectionId === a.sectionId && e.id !== a.id);
      const occ = await move(tokA, v, { entryId: a.id, to: { dayOfWeek: sameSec.dayOfWeek, periodNumber: sameSec.periodNumber }, expectedRevision: 2 });
      check('moving into a slot the section already uses: 409 SLOT_OCCUPIED (use a swap)', occ.status === 409 && codeOf(occ) === 'SLOT_OCCUPIED');
      // a teacher-busy target: another section's lesson of the same teacher
      // any lesson whose section is free at a slot where its teacher teaches ANOTHER section
      let pairBusy: { mover: any; target: any } | null = null;
      for (const x of d.entries) for (const o of d.entries) {
        if (pairBusy || x.id === o.id || x.teacherId !== o.teacherId || x.sectionId === o.sectionId) continue;
        if (!d.entries.some((e: any) => e.sectionId === x.sectionId && e.dayOfWeek === o.dayOfWeek && e.periodNumber === o.periodNumber)) pairBusy = { mover: x, target: o };
      }
      if (pairBusy) {
        const busy = await move(tokA, v, { entryId: pairBusy.mover.id, to: { dayOfWeek: pairBusy.target.dayOfWeek, periodNumber: pairBusy.target.periodNumber }, expectedRevision: 2 });
        check('moving into a slot where the teacher teaches another section: 409 TEACHER_BUSY', busy.status === 409 && codeOf(busy) === 'TEACHER_BUSY', busy.text.slice(0, 160));
      } else check('(fixture) a teacher-busy target exists', false);
      const unknown = await move(tokA, v, { entryId: UUID0, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 2 });
      check('an unknown entry: 404 ENTRY_NOT_FOUND', unknown.status === 404 && codeOf(unknown) === 'ENTRY_NOT_FOUND');
      check('an unknown version: 404', (await move(tokA, UUID0, { entryId: a.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 1 })).status === 404);

      // swap (the section's lessons)
      d = await getV(tokA, v);
      const mates = d.entries.filter((e: any) => e.sectionId === d.entries[20].sectionId);
      let swapReply: Reply | null = null;
      let swapped: [any, any] | null = null;
      for (const x of mates) for (const y2 of mates) {
        if (swapReply?.status === 200 || x.id === y2.id) continue;
        const rr = await move(tokA, v, { entryId: x.id, to: { dayOfWeek: y2.dayOfWeek, periodNumber: y2.periodNumber }, swapWithEntryId: y2.id, expectedRevision: (await getV(tokA, v)).revision });
        if (rr.status === 200) { swapReply = rr; swapped = [x, y2]; }
      }
      check('a swap of two lessons of one section: 200, mode SWAP, two changed lessons, both MANUAL', swapReply?.status === 200 && swapReply.body.data.mode === 'SWAP' && swapReply.body.data.changedEntries.length === 2 && swapReply.body.data.changedEntries.every((e: any) => e.source === 'MANUAL' && e.isLocked === false));
      if (swapped) {
        const [x, y2] = swapped;
        const after = await getV(tokA, v);
        const nx = after.entries.find((e: any) => e.id === x.id);
        const ny = after.entries.find((e: any) => e.id === y2.id);
        check('the two lessons exchanged slots and kept their identities (same ids)', nx.dayOfWeek === y2.dayOfWeek && nx.periodNumber === y2.periodNumber && ny.dayOfWeek === x.dayOfWeek && ny.periodNumber === x.periodNumber);
        const cross = d.entries.find((e: any) => e.sectionId !== x.sectionId);
        const bad = await move(tokA, v, { entryId: x.id, to: { dayOfWeek: cross.dayOfWeek, periodNumber: cross.periodNumber }, swapWithEntryId: cross.id, expectedRevision: after.revision });
        check('swapping lessons of different sections: 400 INVALID_SWAP', bad.status === 400 && codeOf(bad) === 'INVALID_SWAP');
        const self = await move(tokA, v, { entryId: x.id, to: { dayOfWeek: nx.dayOfWeek, periodNumber: nx.periodNumber }, swapWithEntryId: x.id, expectedRevision: after.revision });
        check('swapping a lesson with itself: 400 INVALID_SWAP', self.status === 400 && codeOf(self) === 'INVALID_SWAP');
        const wrongTarget = await move(tokA, v, { entryId: x.id, to: { dayOfWeek: 'FRIDAY', periodNumber: 6 }, swapWithEntryId: ny.id, expectedRevision: after.revision });
        check('a swap whose target is not the partner\'s slot: 400 INVALID_SWAP', wrongTarget.status === 400 && codeOf(wrongTarget) === 'INVALID_SWAP');
        check('a swap with an unknown partner: 404 ENTRY_NOT_FOUND', (await move(tokA, v, { entryId: x.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, swapWithEntryId: UUID0, expectedRevision: after.revision })).status === 404);
      }
      // refused requests never change the revision
      const finalD = await getV(tokA, v);
      check('refused requests did not change the revision, and the timetable is valid', (await validate(tokA, v)).body.data.valid === true && finalD.revision >= 2);
    }

    // ===================================================================================================================
    section('5. A FULL section: moving is impossible, swapping works (API level)');
    {
      const y = await mkYear(worldA, 'full', { sections: 1, subjects: [10, 10, 10] });
      const v = await generate(tokA, y);
      const d = await getV(tokA, v);
      const a = d.entries[0];
      const b = d.entries.find((e: any) => e.subjectId !== a.subjectId);
      const m = await move(tokA, v, { entryId: a.id, to: { dayOfWeek: b.dayOfWeek, periodNumber: b.periodNumber }, expectedRevision: 1 });
      check('a move into any slot of a full section: 409 SLOT_OCCUPIED', m.status === 409 && codeOf(m) === 'SLOT_OCCUPIED');
      const s = await move(tokA, v, { entryId: a.id, to: { dayOfWeek: b.dayOfWeek, periodNumber: b.periodNumber }, swapWithEntryId: b.id, expectedRevision: 1 });
      check('a swap works in the full timetable', s.status === 200 && s.body.data.mode === 'SWAP');
      const after = await getV(tokA, v);
      check('...30 lessons, still valid, no temporary slot visible', after.entries.length === 30 && after.entries.every((e: any) => e.periodNumber >= 1 && e.periodNumber <= 6) && (await validate(tokA, v)).body.data.valid === true);
    }

    // ===================================================================================================================
    section('6. PUT /locks');
    {
      const y = await mkYear(worldA, 'lk');
      const v = await generate(tokA, y);
      const d = await getV(tokA, v);
      const ids = d.entries.slice(0, 3).map((e: any) => e.id);
      const cases: Array<[string, unknown]> = [
        ['no entryIds', { locked: true, expectedRevision: 1 }], ['empty entryIds', { entryIds: [], locked: true, expectedRevision: 1 }], ['malformed id in entryIds', { entryIds: ['x'], locked: true, expectedRevision: 1 }],
        ['duplicate ids', { entryIds: [ids[0], ids[0]], locked: true, expectedRevision: 1 }], ['locked is a string', { entryIds: ids, locked: 'yes', expectedRevision: 1 }], ['locked missing', { entryIds: ids, expectedRevision: 1 }],
        ['expectedRevision missing', { entryIds: ids, locked: true }], ['more than 1000 ids', { entryIds: Array.from({ length: 1001 }, () => UUID0), locked: true, expectedRevision: 1 }], ['an unknown field', { entryIds: ids, locked: true, expectedRevision: 1, teacherId: UUID0 }],
      ];
      for (const [name, payload] of cases) {
        const r = await locks(tokA, v, payload);
        check(`${name}: 400 in the standard envelope`, r.status === 400 && r.body.success === false, `${r.status} ${r.text.slice(0, 120)}`);
      }
      const lock = await locks(tokA, v, { entryIds: ids, locked: true, expectedRevision: 1 });
      check('lock three lessons: 200, changed 3, revision 2, lockedCount 3', lock.status === 200 && lock.body.data.changed === 3 && lock.body.data.unchanged === 0 && lock.body.data.revision === 2 && lock.body.data.lockedCount === 3 && lock.body.data.locked === true, lock.text.slice(0, 200));
      const again = await locks(tokA, v, { entryIds: ids, locked: true, expectedRevision: 2 });
      check('locking them again is idempotent: 200, changed 0, the revision stays 2', again.status === 200 && again.body.data.changed === 0 && again.body.data.unchanged === 3 && again.body.data.revision === 2);
      check('a stale expectedRevision on a no-op is still 409 REVISION_CONFLICT', codeOf(await locks(tokA, v, { entryIds: ids, locked: true, expectedRevision: 1 })) === 'REVISION_CONFLICT');
      const afterLock = await getV(tokA, v);
      check('GET shows lockedCount 3, revision 2 and isLocked on exactly those entries; source untouched', afterLock.lockedCount === 3 && afterLock.revision === 2 && afterLock.entries.filter((e: any) => e.isLocked).map((e: any) => e.id).sort().join() === [...ids].sort().join() && afterLock.manualEditCount === 0);
      const lockedE = afterLock.entries.find((e: any) => e.id === ids[0]);
      const slot = freeSlot(afterLock.entries, lockedE);
      const mv = await move(tokA, v, { entryId: lockedE.id, to: { dayOfWeek: slot![0], periodNumber: slot![1] }, expectedRevision: 2 });
      check('a locked lesson cannot be moved: 409 ENTRY_LOCKED', mv.status === 409 && codeOf(mv) === 'ENTRY_LOCKED');
      const partnerOf = afterLock.entries.find((e: any) => e.sectionId === lockedE.sectionId && !e.isLocked);
      const sw = await move(tokA, v, { entryId: partnerOf.id, to: { dayOfWeek: lockedE.dayOfWeek, periodNumber: lockedE.periodNumber }, swapWithEntryId: lockedE.id, expectedRevision: 2 });
      check('a swap with a locked partner: 409 ENTRY_LOCKED', sw.status === 409 && codeOf(sw) === 'ENTRY_LOCKED');
      const moved = await move(tokA, v, { entryId: partnerOf.id, to: { dayOfWeek: freeSlot(afterLock.entries, partnerOf)![0], periodNumber: freeSlot(afterLock.entries, partnerOf)![1] }, expectedRevision: 2 });
      check('an UNLOCKED lesson moves fine, stays unlocked (moving does not lock) and locked ones keep their slots', moved.status === 200 && (await getV(tokA, v)).entries.find((e: any) => e.id === partnerOf.id).isLocked === false && (await getV(tokA, v)).entries.find((e: any) => e.id === ids[0]).dayOfWeek === lockedE.dayOfWeek);
      const rev = (await getV(tokA, v)).revision;
      const unlock = await locks(tokA, v, { entryIds: [ids[0]], locked: false, expectedRevision: rev });
      check('unlock one lesson: changed 1, lockedCount 2, revision +1', unlock.status === 200 && unlock.body.data.changed === 1 && unlock.body.data.lockedCount === 2 && unlock.body.data.revision === rev + 1);
      check('unlocking an unlocked lesson is an idempotent no-op', (await locks(tokA, v, { entryIds: [ids[0]], locked: false, expectedRevision: rev + 1 })).body.data.changed === 0);
      check('an entry that is not in this version: 404 ENTRY_NOT_FOUND and NOTHING is changed (not even the valid ids)', await (async () => {
        const y2 = await mkYear(worldA, 'lk2');
        const v2 = await generate(tokA, y2);
        const foreign = (await getV(tokA, v2)).entries[0].id;
        const cur = (await getV(tokA, v)).revision;
        const r = await locks(tokA, v, { entryIds: [ids[1], foreign], locked: false, expectedRevision: cur });
        const nowD = await getV(tokA, v);
        return r.status === 404 && codeOf(r) === 'ENTRY_NOT_FOUND' && nowD.revision === cur && nowD.entries.find((e: any) => e.id === ids[1]).isLocked === true;
      })());
      check('an unknown entry id: 404', (await locks(tokA, v, { entryIds: [UUID0], locked: true, expectedRevision: (await getV(tokA, v)).revision })).status === 404);
      check('an unknown version: 404; a malformed one: 400', (await locks(tokA, UUID0, { entryIds: ids, locked: true, expectedRevision: 1 })).status === 404 && (await locks(tokA, 'zzz', { entryIds: ids, locked: true, expectedRevision: 1 })).status === 400);
    }

    // ===================================================================================================================
    section('7. GET /validation');
    {
      const y = await mkYear(worldA, 'val');
      const v = await generate(tokA, y);
      const r = await validate(tokA, v);
      const d = r.body.data;
      check('a fresh draft: 200, valid, not stale, no violations, authoritative metrics', r.status === 200 && d.valid === true && d.isStale === false && d.violations.length === 0 && d.violationCount === 0 && d.metrics.weightsVersion === 'V1', r.text.slice(0, 200));
      check('informational: DRAFT year, 36 lessons, nothing locked or manual, publishable, stats present', d.informational.academicYearStatus === 'DRAFT' && d.informational.entryCount === 36 && d.informational.lockedCount === 0 && d.informational.manualEditCount === 0 && d.informational.publishable === true && d.informational.staleReason === 'NONE' && typeof d.informational.stats.teacherGapPeriods === 'number');
      check('the report names the version, its status and revision', d.versionId === v && d.status === 'DRAFT' && d.revision === 1);
      const e = (await getV(tokA, v)).entries[0];
      const rev0 = (await getV(tokA, v)).revision;
      await validate(tokA, v); await validate(tokA, v);
      const after = await getV(tokA, v);
      check('validation is READ-ONLY: the revision, updatedAt and the lessons are unchanged by it', after.revision === rev0 && after.entries[0].id === e.id && after.updatedAt === (await getV(tokA, v)).updatedAt);
      check('...and it needs no lock: it works while a transaction holds the version row', await (async () => {
        let ok = false;
        await rawPrisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "timetable_versions" WHERE "id" = ${v} FOR UPDATE`;
          ok = (await validate(tokA, v)).status === 200;
        }, { timeout: 30_000 });
        return ok;
      })());

      // corrupt the stored lessons directly (as a stand-in for any bug or manual SQL): the validation must notice
      const pair = (await entriesOfDb(v)).filter((x) => x.sectionId === e.sectionId);
      await prisma.timetableEntry.update({ where: { id: pair[0]!.id }, data: { periodNumber: 99 } });
      const broken = (await validate(tokA, v)).body.data;
      check('a lesson outside the grid is reported: valid false, violation INVALID_PERIOD, metrics null, publishable false', broken.valid === false && broken.violations.some((x: any) => x.code === 'INVALID_PERIOD') && broken.metrics === null && broken.informational.publishable === false);
      await prisma.timetableEntry.update({ where: { id: pair[0]!.id }, data: { periodNumber: pair[0]!.periodNumber } });
      check('...and it is valid again once restored', (await validate(tokA, v)).body.data.valid === true);

      // staleness: a configuration change after generation
      const sa = await prisma.sectionSubjectTeacher.findUniqueOrThrow({ where: { id: y.assignmentIds[0]! } }); // the spare teacher is eligible for exactly this subject
      await prisma.sectionSubjectTeacher.update({ where: { id: sa.id }, data: { teacherId: y.spareTeacherId } });
      const stale = (await validate(tokA, v)).body.data;
      check('after a teaching assignment changed: valid against its own configuration, but isStale (CONFIGURATION_CHANGED) and not publishable', stale.valid === true && stale.isStale === true && stale.informational.staleReason === 'CONFIGURATION_CHANGED' && stale.informational.publishable === false);
      await prisma.sectionSubjectTeacher.update({ where: { id: sa.id }, data: { teacherId: sa.teacherId } });
      check('restoring the configuration makes it current again', (await validate(tokA, v)).body.data.isStale === false);
      await prisma.subjectRequirement.update({ where: { id: y.requirementIds[0]! }, data: { periodsPerWeek: { increment: 1 } } });
      await prisma.subjectRequirement.update({ where: { id: y.requirementIds[0]! }, data: { periodsPerWeek: { decrement: 1 } } });
      check('a change that was undone leaves no trace', (await validate(tokA, v)).body.data.isStale === false);
      await prisma.teacher.update({ where: { id: y.teacherIds[0]! }, data: { isActive: false } });
      const inactive = (await validate(tokA, v)).body.data;
      check('a configuration that no longer normalizes (an assigned teacher deactivated): isStale, CONFIGURATION_NOT_NORMALIZABLE, the issue is listed', inactive.isStale === true && inactive.informational.staleReason === 'CONFIGURATION_NOT_NORMALIZABLE' && inactive.informational.configurationIssues.some((i: any) => i.code === 'TEACHER_INACTIVE'));
      await prisma.teacher.update({ where: { id: y.teacherIds[0]! }, data: { isActive: true } });

      // state
      check('unknown 404, malformed 400, foreign 403 (and nothing leaks)', (await validate(tokA, UUID0)).status === 404 && (await validate(tokA, 'zzz')).status === 400 && (await validate(tokB, v)).status === 403 && !(await validate(tokB, v)).text.includes(v));
    }

    // ===================================================================================================================
    section('8. POST /publish: preconditions and every refusal code');
    {
      const y = await mkYear(worldA, 'pub');
      const v1 = await generate(tokA, y);
      const v2 = await generate(tokA, y);
      const v3 = await generate(tokA, y);
      const body = (rev: number, pub: string | null) => ({ expectedRevision: rev, expectedPublishedVersionId: pub });
      const cases: Array<[string, unknown]> = [['no body', undefined], ['missing expectedRevision', { expectedPublishedVersionId: null }], ['missing expectedPublishedVersionId', { expectedRevision: 1 }], ['malformed expectedPublishedVersionId', body(1, 'x')], ['expectedRevision 0', body(0, null)], ['an unknown field (force)', { ...body(1, null), force: true }], ['an unknown field (status)', { ...body(1, null), status: 'PUBLISHED' }]];
      for (const [name, payload] of cases) {
        const r = payload === undefined ? await app.inject({ method: 'POST', url: `/api/timetable-versions/${v1}/publish`, headers: { cookie: `session_token=${tokA}` } }) : null;
        const reply = r ? { status: r.statusCode } : await publish(tokA, v1, payload);
        check(`${name}: 400`, reply.status === 400, String(reply.status));
      }
      check('nothing was published by a malformed request', (await getV(tokA, v1)).status === 'DRAFT');
      check('unknown version 404; malformed id 400', (await publish(tokA, UUID0, body(1, null))).status === 404 && (await publish(tokA, 'zzz', body(1, null))).status === 400);

      const wrongRev = await publish(tokA, v1, body(9, null));
      check('a wrong revision: 409 REVISION_CONFLICT', wrongRev.status === 409 && codeOf(wrongRev) === 'REVISION_CONFLICT');
      const first = await publish(tokA, v1, body(1, null));
      check('publish the first version: 200, PUBLISHED, revision 2, no archived version, publishedAt', first.status === 200 && first.body.data.status === 'PUBLISHED' && first.body.data.revision === 2 && first.body.data.archivedVersionId === null && typeof first.body.data.publishedAt === 'string', first.text.slice(0, 200));
      const pv = await getV(tokA, v1);
      check('GET: PUBLISHED, revision 2, publishedAt set, archivedAt null', pv.status === 'PUBLISHED' && pv.revision === 2 && pv.publishedAt !== null && pv.archivedAt === null);
      const row = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v1 } });
      check('publishedById is the authenticated admin', row.publishedById === worldA.adminId);
      check('publishing it again: 409 VERSION_NOT_DRAFT with the current status (a retry learns it is done)', await (async () => { const r = await publish(tokA, v1, body(1, null)); return r.status === 409 && codeOf(r) === 'VERSION_NOT_DRAFT' && r.body.data.status === 'PUBLISHED'; })());
      const unaware = await publish(tokA, v2, body(1, null));
      check('publishing a draft without knowing about the published version: 409 PUBLISHED_CHANGED (with its id)', unaware.status === 409 && codeOf(unaware) === 'PUBLISHED_CHANGED' && unaware.body.data.publishedVersionId === v1);
      const wrongPub = await publish(tokA, v2, body(1, v3));
      check('naming the wrong published version: 409 PUBLISHED_CHANGED', wrongPub.status === 409 && codeOf(wrongPub) === 'PUBLISHED_CHANGED');
      check('...and the failed attempts changed nothing (v2 is still an untouched DRAFT, v1 still published)', (await getV(tokA, v2)).status === 'DRAFT' && (await getV(tokA, v2)).revision === 1 && (await getV(tokA, v1)).status === 'PUBLISHED');

      // immutability of the published version
      const e = pv.entries[0];
      check('PUBLISHED: moving a lesson is refused (409 VERSION_NOT_DRAFT)', codeOf(await move(tokA, v1, { entryId: e.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 2 })) === 'VERSION_NOT_DRAFT');
      check('PUBLISHED: locking is refused (409 VERSION_NOT_DRAFT)', codeOf(await locks(tokA, v1, { entryIds: [e.id], locked: true, expectedRevision: 2 })) === 'VERSION_NOT_DRAFT');
      check('PUBLISHED: deleting is refused (409)', (await call('DELETE', `/api/timetable-versions/${v1}`, tokA)).status === 409);
      check('PUBLISHED: validation is still available (read-only)', (await validate(tokA, v1)).status === 200);

      // replace it
      const replace = await publish(tokA, v2, body(1, v1));
      check('publishing the next draft naming the published one: 200, the previous version is reported archived', replace.status === 200 && replace.body.data.archivedVersionId === v1 && replace.body.data.revision === 2, replace.text.slice(0, 200));
      const old = await getV(tokA, v1);
      const neu = await getV(tokA, v2);
      check('the old version is ARCHIVED (archivedAt set, publishedAt kept), the new one PUBLISHED', old.status === 'ARCHIVED' && old.archivedAt !== null && old.publishedAt !== null && neu.status === 'PUBLISHED' && neu.archivedAt === null);
      const lst = (await call('GET', `/api/timetable-versions?academicYearId=${y.yearId}`, tokA)).body.data;
      check('the list shows exactly one PUBLISHED, one ARCHIVED, one DRAFT', lst.filter((x: any) => x.status === 'PUBLISHED').length === 1 && lst.filter((x: any) => x.status === 'ARCHIVED').length === 1 && lst.filter((x: any) => x.status === 'DRAFT').length === 1);
      check('ARCHIVED is immutable: no edit, no lock, no delete, no publish', codeOf(await move(tokA, v1, { entryId: e.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 3 })) === 'VERSION_NOT_DRAFT' && codeOf(await locks(tokA, v1, { entryIds: [e.id], locked: false, expectedRevision: 3 })) === 'VERSION_NOT_DRAFT' && (await call('DELETE', `/api/timetable-versions/${v1}`, tokA)).status === 409 && codeOf(await publish(tokA, v1, body(3, v2))) === 'VERSION_NOT_DRAFT');
      check('there is still no unpublish / restore / archive endpoint (a clone endpoint exists since Phase 7F-2: an invalid lockMode is a 400 and creates nothing)', (await call('POST', `/api/timetable-versions/${v2}/unpublish`, tokA, {})).status === 404 && (await call('POST', `/api/timetable-versions/${v1}/restore`, tokA, {})).status === 404 && (await call('POST', `/api/timetable-versions/${v2}/archive`, tokA, {})).status === 404 && (await call('POST', `/api/timetable-versions/${v2}/clone`, tokA, { lockMode: 'invalid' })).status === 400 && ((await call('GET', `/api/timetable-versions?academicYearId=${y.yearId}`, tokA)).body.data as unknown[]).length === lst.length);
      check('the draft can still be deleted', (await call('DELETE', `/api/timetable-versions/${v3}`, tokA)).status === 200);
      const runOfV3 = await prisma.timetableGenerationRun.findFirstOrThrow({ where: { academicYearId: y.yearId, result: undefined as never } as never }).catch(() => null);
      void runOfV3;
    }

    // ===================================================================================================================
    section('9. Academic year status (D1) and stale configuration at publish');
    {
      const y = await mkYear(worldA, 'yr');
      const v = await generate(tokA, y);
      const e = (await getV(tokA, v)).entries[0];
      await prisma.academicYear.update({ where: { id: y.yearId }, data: { status: 'ACTIVE' } });
      check('ACTIVE year: a move is allowed', (await move(tokA, v, { entryId: e.id, to: { dayOfWeek: freeSlot((await getV(tokA, v)).entries, e)![0], periodNumber: freeSlot((await getV(tokA, v)).entries, e)![1] }, expectedRevision: 1 })).status === 200);
      check('ACTIVE year: locking is allowed', (await locks(tokA, v, { entryIds: [e.id], locked: true, expectedRevision: 2 })).status === 200);
      check('ACTIVE year: generation is still refused (YEAR_NOT_DRAFT, 400)', (await call('POST', '/api/timetable-generations', tokA, { academicYearId: y.yearId })).status === 400);
      const pub = await publish(tokA, v, { expectedRevision: 3, expectedPublishedVersionId: null });
      check('ACTIVE year: publishing is allowed', pub.status === 200 && (await getV(tokA, v)).status === 'PUBLISHED', pub.text.slice(0, 160));
      const y2 = await mkYear(worldA, 'yr2');
      const v2 = await generate(tokA, y2);
      const e2 = (await getV(tokA, v2)).entries[0];
      await prisma.academicYear.update({ where: { id: y2.yearId }, data: { status: 'ACTIVE' } });
      await prisma.academicYear.update({ where: { id: y2.yearId }, data: { status: 'COMPLETED' } });
      const done: Array<[string, Reply]> = [
        ['move', await move(tokA, v2, { entryId: e2.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 1 })],
        ['locks', await locks(tokA, v2, { entryIds: [e2.id], locked: true, expectedRevision: 1 })],
        ['publish', await publish(tokA, v2, { expectedRevision: 1, expectedPublishedVersionId: null })],
      ];
      for (const [name, r] of done) check(`COMPLETED year: ${name} is refused with 409 ACADEMIC_YEAR_NOT_EDITABLE`, r.status === 409 && codeOf(r) === 'ACADEMIC_YEAR_NOT_EDITABLE', `${r.status} ${r.text.slice(0, 100)}`);
      check('COMPLETED year: validation and reading still work', (await validate(tokA, v2)).status === 200 && (await getV(tokA, v2)).status === 'DRAFT');

      // stale configuration at publish
      const y3 = await mkYear(worldA, 'stale');
      const v3 = await generate(tokA, y3);
      const sa = await prisma.sectionSubjectTeacher.findUniqueOrThrow({ where: { id: y3.assignmentIds[0]! } });
      await prisma.sectionSubjectTeacher.update({ where: { id: sa.id }, data: { teacherId: y3.spareTeacherId } });
      const r = await publish(tokA, v3, { expectedRevision: 1, expectedPublishedVersionId: null });
      check('a draft generated before an assignment changed: 409 STALE_CONFIGURATION (CONFIGURATION_CHANGED), nothing published', r.status === 409 && codeOf(r) === 'STALE_CONFIGURATION' && r.body.data.reason === 'CONFIGURATION_CHANGED' && (await getV(tokA, v3)).status === 'DRAFT' && (await getV(tokA, v3)).revision === 1, r.text.slice(0, 200));
      await prisma.sectionSubjectTeacher.update({ where: { id: sa.id }, data: { teacherId: sa.teacherId } });
      await prisma.teacher.update({ where: { id: y3.teacherIds[1]! }, data: { isActive: false } });
      const r2 = await publish(tokA, v3, { expectedRevision: 1, expectedPublishedVersionId: null });
      check('a configuration that no longer normalizes: 409 STALE_CONFIGURATION (CONFIGURATION_NOT_NORMALIZABLE) with the issues', r2.status === 409 && r2.body.data.reason === 'CONFIGURATION_NOT_NORMALIZABLE' && r2.body.data.issues.some((i: any) => i.code === 'TEACHER_INACTIVE'));
      await prisma.teacher.update({ where: { id: y3.teacherIds[1]! }, data: { isActive: true } });
      check('...and once the configuration is as it was, the same draft publishes', (await publish(tokA, v3, { expectedRevision: 1, expectedPublishedVersionId: null })).status === 200);
      // a draft made invalid by direct damage cannot be published (fresh validation)
      const y4 = await mkYear(worldA, 'invalid');
      const v4 = await generate(tokA, y4);
      const victim = (await getV(tokA, v4)).entries[5];
      await prisma.timetableEntry.delete({ where: { id: victim.id } });
      const bad = await publish(tokA, v4, { expectedRevision: 1, expectedPublishedVersionId: null });
      check('a draft whose lessons violate the hard constraints: 409 VALIDATION_FAILED with violations, nothing published', bad.status === 409 && codeOf(bad) === 'VALIDATION_FAILED' && bad.body.data.violationCount >= 1 && (await getV(tokA, v4)).status === 'DRAFT');
    }

    // ===================================================================================================================
    section('10. School isolation: a malicious admin of School B');
    {
      const y = await mkYear(worldA, 'iso');
      const v = await generate(tokA, y);
      const d = await getV(tokA, v);
      const e = d.entries[0];
      const slot = freeSlot(d.entries, e)!;
      const yB = await mkYear(worldB, 'isoB');
      const vB = await generate(tokB, yB);
      const eB = (await getV(tokB, vB)).entries[0];
      const attempts: Array<[string, Reply]> = [
        ['GET version', await call('GET', `/api/timetable-versions/${v}`, tokB)],
        ['moves', await move(tokB, v, { entryId: e.id, to: { dayOfWeek: slot[0], periodNumber: slot[1] }, expectedRevision: 1 })],
        ['locks', await locks(tokB, v, { entryIds: [e.id], locked: true, expectedRevision: 1 })],
        ['validation', await validate(tokB, v)],
        ['publish', await publish(tokB, v, { expectedRevision: 1, expectedPublishedVersionId: null })],
        ['delete', await call('DELETE', `/api/timetable-versions/${v}`, tokB)],
      ];
      for (const [name, r] of attempts) {
        check(`${name} on School A's version as School B: 403 and the body reveals nothing`, r.status === 403 && !r.text.includes(v) && !r.text.includes(e.id) && !r.text.includes(worldA.schoolId) && !r.text.includes('metrics') && !r.text.includes('entries'), `${r.status} ${r.text.slice(0, 120)}`);
      }
      // B's own version, but A's entry id: the entry is simply not found there
      const cross = await move(tokB, vB, { entryId: e.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 1 });
      check('School B\'s own version with School A\'s entry id (moves): 404 ENTRY_NOT_FOUND, and School A\'s lesson is untouched', cross.status === 404 && codeOf(cross) === 'ENTRY_NOT_FOUND' && (await getV(tokA, v)).entries.find((x: any) => x.id === e.id).dayOfWeek === e.dayOfWeek);
      const crossSwap = await move(tokB, vB, { entryId: eB.id, to: { dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber }, swapWithEntryId: e.id, expectedRevision: 1 });
      check('...swapping with School A\'s entry: 404 ENTRY_NOT_FOUND', crossSwap.status === 404);
      const crossLock = await locks(tokB, vB, { entryIds: [eB.id, e.id], locked: true, expectedRevision: 1 });
      check('...locking School A\'s entry through School B\'s version: 404, and School B\'s own entry is NOT locked either', crossLock.status === 404 && (await getV(tokB, vB)).lockedCount === 0 && (await getV(tokA, v)).lockedCount === 0);
      check('a client-supplied schoolId changes nothing', (await call('POST', `/api/timetable-versions/${v}/publish`, tokB, { expectedRevision: 1, expectedPublishedVersionId: null, schoolId: worldA.schoolId })).status === 400);
      const after = await getV(tokA, v);
      check('School A\'s version is untouched by all of it (revision 1, DRAFT, nothing locked or manual)', after.revision === 1 && after.status === 'DRAFT' && after.lockedCount === 0 && after.manualEditCount === 0);
      // service-level
      const { timetableVersionEditService } = await import('./src/modules/timetable-version/timetable-version.edit-service.js');
      const { timetableVersionPublishService } = await import('./src/modules/timetable-version/timetable-version.publish-service.js');
      const rej = async (fn: () => Promise<unknown>) => { try { await fn(); return 'resolved'; } catch (error: any) { return error.statusCode ?? 'other'; } };
      check('service level: move, locks, validate and publish by School B on School A\'s version: all 403', (await rej(() => timetableVersionEditService.move(worldB.schoolId, v, { entryId: e.id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 1 }))) === 403
        && (await rej(() => timetableVersionEditService.setLocks(worldB.schoolId, v, { entryIds: [e.id], locked: true, expectedRevision: 1 }))) === 403
        && (await rej(() => timetableVersionPublishService.validate(worldB.schoolId, v))) === 403
        && (await rej(() => timetableVersionPublishService.publish({ id: worldB.adminId, schoolId: worldB.schoolId }, v, { expectedRevision: 1, expectedPublishedVersionId: null }))) === 403);
      check('and a School B admin id cannot publish School A\'s version even with School A\'s schoolId (the version is looked up by id AND school)', (await rej(() => timetableVersionPublishService.publish({ id: worldB.adminId, schoolId: worldA.schoolId }, vB, { expectedRevision: 1, expectedPublishedVersionId: null }))) === 403);
      check('School B can use its own version fully', (await publish(tokB, vB, { expectedRevision: 1, expectedPublishedVersionId: null })).status === 200);
    }

    // ===================================================================================================================
    section('11. Two admins of one school (HTTP): stale revisions, concurrent edits and publishes');
    {
      const y = await mkYear(worldA, 'two');
      const v = await generate(tokA, y);
      const d = await getV(tokA, v);
      const e1 = d.entries[0];
      const e2 = d.entries.find((e: any) => e.sectionId !== e1.sectionId && e.teacherId !== e1.teacherId);
      const [s1, s2] = [freeSlot(d.entries, e1)!, freeSlot(d.entries, e2)!];
      const [ra, rb] = await Promise.all([
        move(tokA, v, { entryId: e1.id, to: { dayOfWeek: s1[0], periodNumber: s1[1] }, expectedRevision: 1 }),
        move(tokA2, v, { entryId: e2.id, to: { dayOfWeek: s2[0], periodNumber: s2[1] }, expectedRevision: 1 }),
      ]);
      const codes = [ra, rb].map((r) => (r.status === 200 ? 'OK' : codeOf(r)));
      check('both admins edit at revision 1 at the same time: one succeeds, the other gets REVISION_CONFLICT', codes.filter((c) => c === 'OK').length === 1 && codes.filter((c) => c === 'REVISION_CONFLICT').length === 1, codes.join(','));
      const loser = ra.status === 200 ? { tok: tokA2, e: e2, s: s2 } : { tok: tokA, e: e1, s: s1 };
      const fresh = await getV(loser.tok, v);
      const retry = await move(loser.tok, v, { entryId: loser.e.id, to: { dayOfWeek: loser.s[0], periodNumber: loser.s[1] }, expectedRevision: fresh.revision });
      check('the loser reloads, retries with the new revision and succeeds: both edits are present, nothing was lost', retry.status === 200 && (await getV(tokA, v)).manualEditCount === 2 && (await getV(tokA, v)).revision === 3);

      // publish while the other admin keeps editing
      const rev = (await getV(tokA, v)).revision;
      const slot3 = freeSlot((await getV(tokA, v)).entries, e1);
      const [p, ed] = await Promise.all([
        publish(tokA, v, { expectedRevision: rev, expectedPublishedVersionId: null }),
        move(tokA2, v, { entryId: e1.id, to: { dayOfWeek: slot3![0], periodNumber: slot3![1] }, expectedRevision: rev }),
      ]);
      const pc = p.status === 200 ? 'OK' : codeOf(p);
      const ec = ed.status === 200 ? 'OK' : codeOf(ed);
      check(`publish vs edit at the same revision: exactly one wins (${pc} / ${ec})`, (pc === 'OK' && ec === 'VERSION_NOT_DRAFT') || (ec === 'OK' && pc === 'REVISION_CONFLICT'), `${pc}/${ec}`);
      check('...and the end state is consistent (published iff the publish succeeded)', ((await getV(tokA, v)).status === 'PUBLISHED') === (pc === 'OK'));
    }

    // ===================================================================================================================
    section('12. REAL end-to-end: generate (real Python) -> review -> move -> swap -> lock -> validate -> publish -> archive the previous');
    {
      const y = await mkYear(worldA, 'e2e', TIGHT);
      const real = makeRunner(new SubprocessSolverClient(resolveSolverClientConfig({}, {})));
      forwardTo = real;
      real.start();
      const v1 = await generate(tokA, y);
      const first = await getV(tokA, v1);
      check('a real CP-SAT draft: DRAFT, CP_SAT, revision 1, 87 lessons, valid', first.status === 'DRAFT' && first.solutionSource === 'CP_SAT' && first.revision === 1 && first.entries.length === 87 && (await validate(tokA, v1)).body.data.valid === true);
      // review: move one lesson, swap two, lock a few, validate, publish
      const a = first.entries[0];
      const slot = freeSlot(first.entries, a);
      let rev = 1;
      if (slot) {
        const m = await move(tokA, v1, { entryId: a.id, to: { dayOfWeek: slot[0], periodNumber: slot[1] }, expectedRevision: rev });
        check('e2e: move a lesson of the CP-SAT timetable', m.status === 200, m.text.slice(0, 160));
        if (m.status === 200) rev = m.body.data.revision;
      }
      const d1 = await getV(tokA, v1);
      const mates = d1.entries.filter((e: any) => e.sectionId === d1.entries[30].sectionId);
      let swappedOk = false;
      for (const x of mates) for (const y2 of mates) {
        if (swappedOk || x.id === y2.id) continue;
        const r = await move(tokA, v1, { entryId: x.id, to: { dayOfWeek: y2.dayOfWeek, periodNumber: y2.periodNumber }, swapWithEntryId: y2.id, expectedRevision: rev });
        if (r.status === 200) { swappedOk = true; rev = r.body.data.revision; }
      }
      check('e2e: swap two lessons of a section', swappedOk);
      const lk = await locks(tokA, v1, { entryIds: d1.entries.slice(60, 64).map((e: any) => e.id), locked: true, expectedRevision: rev });
      check('e2e: lock four lessons', lk.status === 200 && lk.body.data.lockedCount === 4);
      rev = lk.body.data.revision;
      const rep = (await validate(tokA, v1)).body.data;
      check('e2e: validation after the edits: valid, current, publishable, edits and locks counted', rep.valid && !rep.isStale && rep.informational.publishable && rep.informational.lockedCount === 4 && rep.informational.manualEditCount >= 2 && rep.revision === rev, JSON.stringify(rep.informational).slice(0, 200));
      const pub1 = await publish(tokA, v1, { expectedRevision: rev, expectedPublishedVersionId: null });
      check('e2e: publish the reviewed draft', pub1.status === 200 && pub1.body.data.archivedVersionId === null);
      const published = await getV(tokA, v1);
      check('e2e: the published version keeps its edits, locks and provenance, and is immutable', published.status === 'PUBLISHED' && published.lockedCount === 4 && published.manualEditCount >= 2 && published.solutionSource === 'CP_SAT' && published.entries.length === 87);

      // a second generation, review and publish: the first one is archived
      const v2 = await generate(tokA, y);
      const d2 = await getV(tokA, v2);
      check('e2e: regeneration creates a NEW draft (version 2); the published version is untouched and its locks are NOT carried over by a plain generation (only a generation started with sourceVersionId keeps them)', d2.versionNumber === 2 && d2.lockedCount === 0 && d2.manualEditCount === 0 && (await getV(tokA, v1)).status === 'PUBLISHED' && (await getV(tokA, v1)).lockedCount === 4);
      const pub2 = await publish(tokA, v2, { expectedRevision: 1, expectedPublishedVersionId: v1 });
      check('e2e: publishing version 2 archives version 1 in the same step', pub2.status === 200 && pub2.body.data.archivedVersionId === v1);
      const lst = (await call('GET', `/api/timetable-versions?academicYearId=${y.yearId}`, tokA)).body.data;
      check('e2e: the history is preserved (v1 ARCHIVED with its edits, v2 PUBLISHED)', lst.find((x: any) => x.id === v1).status === 'ARCHIVED' && lst.find((x: any) => x.id === v1).lockedCount === 4 && lst.find((x: any) => x.id === v2).status === 'PUBLISHED');
      check('e2e: the generation endpoint still works as in Phase 6 and fixedEntries stay empty in every stored snapshot', (await prisma.timetableVersion.findMany({ where: { academicYearId: y.yearId } })).every((x) => ((x.inputSnapshot as { fixedEntries: unknown[] }).fixedEntries ?? []).length === 0));
      forwardTo = scripted;
      await real.stop(10);
      check('no solver process remains', await waitFor(() => solverProcesses().length === 0, 8_000, 200));
    }

    // ===================================================================================================================
    section('13. Deleting a draft keeps run history (Phase 6 caveat, documented contract) and the computed versionDeleted flag');
    {
      const y = await mkYear(worldA, 'hist');
      const r = await call('POST', '/api/timetable-generations', tokA, { academicYearId: y.yearId });
      const run = await waitTerminal(r.body.data.generationRunId, 90_000);
      const before = (await call('GET', `/api/timetable-generations/${run.id}`, tokA)).body.data;
      check('before the delete: versionId set, versionDeleted false', before.versionId === run.versionId && before.versionDeleted === false);
      check('delete the draft', (await call('DELETE', `/api/timetable-versions/${run.versionId}`, tokA)).status === 200);
      const afterRun = (await call('GET', `/api/timetable-generations/${run.id}`, tokA)).body.data;
      check('after: versionId null (the live link), result.versionId keeps the historical id, versionDeleted true, status still SUCCEEDED', afterRun.versionId === null && afterRun.result.versionId === run.versionId && afterRun.versionDeleted === true && afterRun.status === 'SUCCEEDED');
      const stored = await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: run.id } });
      check('the stored run history was NOT rewritten (resultSummary identical, only the FK link became null)', JSON.stringify(stored.resultSummary) === JSON.stringify(run.resultSummary) && stored.versionId === null);
      const failed = await prisma.timetableGenerationRun.create({ data: { schoolId: worldA.schoolId, academicYearId: y.yearId, status: 'FAILED', failureCode: 'NOT_READY', options: {}, timeLimitSeconds: 10, workers: 1, sectionCount: 3 } });
      check('a FAILED run never reports versionDeleted', (await call('GET', `/api/timetable-generations/${failed.id}`, tokA)).body.data.versionDeleted === false);
    }

    // ===================================================================================================================
    section('14. Swagger: the four new operations and the extended ones');
    {
      const spec = app.swagger() as any;
      const ops: Array<{ method: string; path: string; op: any }> = [];
      for (const [p, item] of Object.entries<any>(spec.paths)) for (const [m, op] of Object.entries<any>(item)) if (['get', 'post', 'delete', 'put', 'patch'].includes(m)) ops.push({ method: m, path: p, op });
      const mine = ops.filter((o) => o.path.startsWith('/api/timetable-versions') || o.path.startsWith('/api/timetable-generations'));
      const expected = ['GET /api/timetable-generations', 'GET /api/timetable-generations/{id}', 'POST /api/timetable-generations', 'GET /api/timetable-versions', 'GET /api/timetable-versions/{id}', 'DELETE /api/timetable-versions/{id}', 'POST /api/timetable-versions/{id}/moves', 'PUT /api/timetable-versions/{id}/locks', 'GET /api/timetable-versions/{id}/timetable', 'POST /api/timetable-versions/{id}/clone', 'GET /api/timetable-versions/{id}/validation', 'POST /api/timetable-versions/{id}/publish'].sort();
      check(`exactly the 12 approved generation/version operations are documented (the 10 of Phases 6-7, the Phase 7F-1 timetable view and the Phase 7F-2 clone): ${mine.length}`, JSON.stringify(mine.map((o) => `${o.method.toUpperCase()} ${o.path}`).sort()) === JSON.stringify(expected), mine.map((o) => `${o.method} ${o.path}`).join(' | '));
      const ids = ops.map((o) => o.op.operationId).filter(Boolean);
      check('every new operation has an operationId, summary, description and one tag; ids are unique across the API', mine.every((o) => o.op.operationId && o.op.summary && o.op.description && o.op.tags?.length === 1) && new Set(ids).size === ids.length);
      check('the four new operations have the expected ids', ['moveTimetableEntry', 'setTimetableEntryLocks', 'validateTimetableVersion', 'publishTimetableVersion'].every((id) => ids.includes(id)));
      check('every operation requires the session cookie and documents 401', mine.every((o) => JSON.stringify(o.op.security) === JSON.stringify([{ cookieAuth: [] }]) && o.op.responses['401']));
      const codes = (m: string, p: string) => Object.keys(mine.find((o) => o.method === m && o.path === p)!.op.responses).sort().join(',');
      check('moves documents 200, 400, 401, 403, 404, 409, 503', codes('post', '/api/timetable-versions/{id}/moves') === '200,400,401,403,404,409,503');
      check('locks documents 200, 400, 401, 403, 404, 409, 503', codes('put', '/api/timetable-versions/{id}/locks') === '200,400,401,403,404,409,503');
      check('validation documents 200, 400, 401, 403, 404, 409', codes('get', '/api/timetable-versions/{id}/validation') === '200,400,401,403,404,409');
      check('publish documents 200, 400, 401, 403, 404, 409, 503', codes('post', '/api/timetable-versions/{id}/publish') === '200,400,401,403,404,409,503');
      const body = (m: string, p: string) => mine.find((o) => o.method === m && o.path === p)!.op.requestBody.content['application/json'].schema;
      const mb = body('post', '/api/timetable-versions/{id}/moves');
      check('moves request schema: entryId, to{dayOfWeek,periodNumber}, swapWithEntryId?, expectedRevision (required), no extra properties, no teacher/subject/section field', JSON.stringify([...mb.required].sort()) === '["entryId","expectedRevision","to"]' && mb.additionalProperties === false && JSON.stringify(Object.keys(mb.properties).sort()) === '["entryId","expectedRevision","swapWithEntryId","to"]' && mb.properties.to.additionalProperties === false);
      const lb = body('put', '/api/timetable-versions/{id}/locks');
      check('locks request schema: entryIds (1..1000, unique), locked, expectedRevision', JSON.stringify([...lb.required].sort()) === '["entryIds","expectedRevision","locked"]' && lb.properties.entryIds.maxItems === 1000 && lb.properties.entryIds.minItems === 1 && lb.properties.entryIds.uniqueItems === true && lb.additionalProperties === false);
      const pb = body('post', '/api/timetable-versions/{id}/publish');
      check('publish request schema: expectedRevision and a REQUIRED nullable expectedPublishedVersionId', JSON.stringify([...pb.required].sort()) === '["expectedPublishedVersionId","expectedRevision"]' && pb.properties.expectedPublishedVersionId.nullable === true && pb.additionalProperties === false);
      check('the descriptions document the revision behaviour, the publish behaviour and the lock behaviour', /expectedRevision/.test(mine.find((o) => o.path.endsWith('/moves'))!.op.description) && /archived/i.test(mine.find((o) => o.path.endsWith('/publish'))!.op.description) && /idempotent/i.test(mine.find((o) => o.path.endsWith('/locks'))!.op.description) && /read-only/i.test(mine.find((o) => o.path.endsWith('/validation'))!.op.description));
      const stable = ['REVISION_CONFLICT', 'ENTRY_LOCKED', 'SLOT_OCCUPIED', 'TEACHER_BUSY', 'INVALID_SLOT', 'INVALID_SWAP', 'PUBLISHED_CHANGED', 'STALE_CONFIGURATION', 'VALIDATION_FAILED', 'VERSION_NOT_DRAFT', 'ACADEMIC_YEAR_NOT_EDITABLE'];
      check('every stable error code is named in the documentation of the operations that return it', stable.every((c) => mine.some((o) => String(o.op.description).includes(c))));

      // documented fields == live fields
      const live = (await getV(tokA, (await prisma.timetableVersion.findFirstOrThrow({ where: { schoolId: worldA.schoolId }, orderBy: { createdAt: 'desc' } })).id));
      const verSchema = mine.find((o) => o.method === 'get' && o.path === '/api/timetable-versions/{id}')!.op.responses['200'].content['application/json'].schema.properties.data;
      check('every field of a version (including revision, publishedAt, archivedAt, lockedCount, manualEditCount) is documented, and nothing documented is missing', JSON.stringify(Object.keys(live).sort()) === JSON.stringify(Object.keys(verSchema.properties).sort()), `${Object.keys(live).sort().join(',')}`);
      const sumSchema = mine.find((o) => o.method === 'get' && o.path === '/api/timetable-versions')!.op.responses['200'].content['application/json'].schema.properties.data.items;
      const liveList = (await call('GET', `/api/timetable-versions?academicYearId=${live.academicYearId}`, tokA)).body.data[0];
      const liveListStale = (await call('GET', `/api/timetable-versions?academicYearId=${live.academicYearId}&includeStaleness=true`, tokA)).body.data[0];
      const documented = Object.keys(sumSchema.properties).sort();
      check('every field of a version summary is documented: the default response has exactly the documented fields minus the two opt-in ones (isStale, staleReason, Phase 7F-3), and with includeStaleness=true exactly all of them', JSON.stringify(Object.keys(liveList).sort()) === JSON.stringify(documented.filter((k) => !['isStale', 'staleReason'].includes(k))) && JSON.stringify(Object.keys(liveListStale).sort()) === JSON.stringify(documented), `${Object.keys(liveList).sort().join(',')} | ${Object.keys(liveListStale).sort().join(',')}`);
      const runSchema = mine.find((o) => o.method === 'get' && o.path === '/api/timetable-generations/{id}')!.op.responses['200'].content['application/json'].schema.properties.data;
      const someRun = await prisma.timetableGenerationRun.findFirstOrThrow({ where: { schoolId: worldA.schoolId, status: 'SUCCEEDED' } });
      check('every field of a generation run (including versionDeleted) is documented', JSON.stringify(Object.keys((await call('GET', `/api/timetable-generations/${someRun.id}`, tokA)).body.data).sort()) === JSON.stringify(Object.keys(runSchema.properties).sort()));

      // live responses against the documented shapes
      const yS = await mkYear(worldA, 'swg');
      const vS = await generate(tokA, yS);
      const dS = await getV(tokA, vS);
      const mvR = (await move(tokA, vS, { entryId: dS.entries[0].id, to: { dayOfWeek: freeSlot(dS.entries, dS.entries[0])![0], periodNumber: freeSlot(dS.entries, dS.entries[0])![1] }, expectedRevision: 1 })).body.data;
      const mvSchema = mine.find((o) => o.path.endsWith('/moves'))!.op.responses['200'].content['application/json'].schema.properties.data;
      check('every field of the moves response is documented', JSON.stringify(Object.keys(mvR).sort()) === JSON.stringify(Object.keys(mvSchema.properties).sort()) && JSON.stringify(Object.keys(mvR.changedEntries[0]).sort()) === JSON.stringify(Object.keys(mvSchema.properties.changedEntries.items.properties).sort()), Object.keys(mvR).join(','));
      const lkR = (await locks(tokA, vS, { entryIds: [dS.entries[1].id], locked: true, expectedRevision: 2 })).body.data;
      const lkSchema = mine.find((o) => o.path.endsWith('/locks'))!.op.responses['200'].content['application/json'].schema.properties.data;
      check('every field of the locks response is documented', JSON.stringify(Object.keys(lkR).sort()) === JSON.stringify(Object.keys(lkSchema.properties).sort()));
      const vlR = (await validate(tokA, vS)).body.data;
      const vlSchema = mine.find((o) => o.path.endsWith('/validation'))!.op.responses['200'].content['application/json'].schema.properties.data;
      check('every field of the validation response (and of informational) is documented', JSON.stringify(Object.keys(vlR).sort()) === JSON.stringify(Object.keys(vlSchema.properties).sort()) && JSON.stringify(Object.keys(vlR.informational).sort()) === JSON.stringify(Object.keys(vlSchema.properties.informational.properties).sort()));
      const pbR = (await publish(tokA, vS, { expectedRevision: 3, expectedPublishedVersionId: null })).body.data;
      const pbSchema = mine.find((o) => o.path.endsWith('/publish'))!.op.responses['200'].content['application/json'].schema.properties.data;
      check('every field of the publish response is documented', JSON.stringify(Object.keys(pbR).sort()) === JSON.stringify(Object.keys(pbSchema.properties).sort()), Object.keys(pbR).join(','));
      const refusal = await move(tokA, vS, { entryId: dS.entries[0].id, to: { dayOfWeek: 'MONDAY', periodNumber: 1 }, expectedRevision: 3 });
      check('a refusal is the standard envelope plus data.code: {success, message, data:{code,...}}', refusal.body.success === false && typeof refusal.body.message === 'string' && typeof refusal.body.data.code === 'string' && JSON.stringify(Object.keys(refusal.body).sort()) === '["data","message","success"]');
      const docs = await app.inject({ method: 'GET', url: '/docs/json' });
      check('Swagger loads (/docs/json) and lists the new paths', docs.statusCode === 200 && ['/api/timetable-versions/{id}/moves', '/api/timetable-versions/{id}/locks', '/api/timetable-versions/{id}/validation', '/api/timetable-versions/{id}/publish'].every((p) => JSON.parse(docs.body).paths[p]));
    }

    // ===================================================================================================================
    section('15. Security: no secrets, no process information, bounded output');
    {
      const y = await mkYear(worldA, 'sec');
      const v = await generate(tokA, y);
      const d = await getV(tokA, v);
      const replies = [(await validate(tokA, v)).text, (await move(tokA, v, { entryId: d.entries[0].id, to: { dayOfWeek: freeSlot(d.entries, d.entries[0])![0], periodNumber: freeSlot(d.entries, d.entries[0])![1] }, expectedRevision: 1 })).text, (await locks(tokA, v, { entryIds: [d.entries[1].id], locked: true, expectedRevision: 2 })).text, (await publish(tokA, v, { expectedRevision: 3, expectedPublishedVersionId: null })).text, (await publish(tokB, v, { expectedRevision: 4, expectedPublishedVersionId: null })).text, JSON.stringify(await getV(tokA, v))];
      const sensitive = [tokA, tokB, tokA2, 'passwordHash', 'leaseOwner', 'leaseExpiresAt', 'DATABASE_URL', 'COOKIE_SECRET', PASSWORD, 'stderrTail', 'inputSnapshot'];
      check('no response contains a session token, password hash, lease field, env secret, process detail or the raw input snapshot', replies.every((r) => sensitive.every((s) => !r.includes(s))));
      const injection = await call('GET', `/api/timetable-versions/${encodeURIComponent("1; DROP TABLE timetable_versions")}/validation`, tokA);
      check('an injection string as :id is a plain 400 and the table is intact', injection.status === 400 && (await prisma.timetableVersion.count()) >= 1);
      const huge = await move(tokA, v, { entryId: UUID0, to: { dayOfWeek: 'M'.repeat(5000), periodNumber: 1 }, expectedRevision: 1 });
      check('a 5000-character day name is rejected (bounded input), not echoed back', huge.status === 400 && huge.text.length < 2000 && !huge.text.includes('MMMMMMMMMM'));
    }
  } finally {
    section('16. Cleanup and proof that nothing existing changed, nothing is left running');
    forwardTo = null;
    registerGenerationRunner(null);
    for (const r of runners) { try { await r.stop(5); } catch { /* already stopped */ } }
    await app.close();
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    let deleted = 0;
    for (const w of worlds) deleted += await destroyWorld(w);
    check('exactly the two test schools were deleted (cascade)', deleted === 2, String(deleted));
    check('the new tables are back to their starting counts (no run, version or entry left)', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore), JSON.stringify(await newTableCounts()));
    const after = await fingerprint();
    const unchanged = EXISTING_TABLES.filter((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h);
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, unchanged.length === EXISTING_TABLES.length, EXISTING_TABLES.filter((t) => !unchanged.includes(t)).join(','));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11VA_' } } })) === 0);
    check('no solver process remains', solverProcesses().length === 0, solverProcesses().join(' | '));
  }
}

async function entriesOfDb(versionId: string) {
  return prisma.timetableEntry.findMany({ where: { versionId }, orderBy: [{ sectionId: 'asc' }, { dayOfWeek: 'asc' }, { periodNumber: 'asc' }] });
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
