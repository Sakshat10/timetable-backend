// Module 11 - Phase 7B: the PURE rules of editing, locking and publishing a timetable version. No database, no network.
import {
  applyPlan, assessStaleness, canDeleteVersion, canTransition, checkMutable, checkPublishable, configurationHash, EDIT_ERROR_CODES, isEditableStatus,
  isYearEditable, lockedCount, manualEditCount, metricsDelta, planLocks, planMove, problemFromCore, rowsFromEntries, SnapshotUnusableError,
  validateVersion, VERSION_TRANSITIONS, type EditableEntry, type MoveRequest, type VersionStatus, type YearStatus,
} from './src/modules/timetable-version/timetable-version.edit-core.js';
import { buildBaseline } from './src/modules/timetable-generation/timetable-generation.baseline.js';
import { evaluateMetrics } from './src/modules/timetable-generation/timetable-generation.metrics.js';
import { hashJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import { validateEntries } from './src/modules/timetable-generation/timetable-generation.validator.js';
import { WEIGHTS_V1, type SolverProblemCore } from './src/modules/timetable-generation/timetable-generation.contracts.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
const WEEK = DAYS.slice(0, 5);

/** A deterministic problem core: `sections` sections, one teacher per subject, `periods[i]` periods per week for subject i. */
function makeCore(sections: number, periods: number[], periodsPerDay = 6, days = 5): SolverProblemCore {
  const sectionIds = Array.from({ length: sections }, (_, i) => `sec-${i + 1}`);
  const teacherIds = periods.map((_, i) => `tea-${i + 1}`);
  const assignments = sectionIds.flatMap((s, si) => periods.map((p, i) => ({ id: `asg-${si + 1}-${i + 1}`, sectionId: s, subjectId: `sub-${i + 1}`, subjectRequirementId: `req-${i + 1}`, teacherId: teacherIds[i]!, periodsPerWeek: p })));
  return {
    contractVersion: '1.0',
    grid: { days: DAYS.slice(0, days).map((dayOfWeek, index) => ({ index, dayOfWeek })), periods: Array.from({ length: periodsPerDay }, (_, k) => ({ periodNumber: k + 1, continuesIntoNext: false })), maxTeacherPeriodsPerWeek: 32 },
    sections: sectionIds.map((id) => ({ id })),
    teachers: teacherIds.map((id) => ({ id, weeklyCapacity: Math.min(32, days * periodsPerDay) })),
    assignments,
    fixedEntries: [],
  } as unknown as SolverProblemCore;
}
/** A deep copy with every object's keys in REVERSE sorted order (what a JSONB round trip may do to key order). */
const reorderKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reorderKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().reverse().map((k) => [k, reorderKeys((value as Record<string, unknown>)[k])])) : value;
const ctx = { schoolId: 'school-1', academicYear: { id: 'year-1', name: 'Y' } };

function timetableOf(core: SolverProblemCore, seed = 7) {
  const problem = problemFromCore(JSON.parse(JSON.stringify(core)), ctx); // through JSON, like the database
  const baseline = buildBaseline(problem, seed);
  if (!baseline.ok) throw new Error('baseline failed');
  const entries: EditableEntry[] = baseline.entries.map((r, i) => {
    const a = problem.core.assignments.find((x) => x.id === r.assignmentId)!;
    return { id: `e-${String(i).padStart(4, '0')}`, sectionId: r.sectionId, subjectId: r.subjectId, teacherId: r.teacherId, subjectRequirementId: a.subjectRequirementId, dayOfWeek: r.dayOfWeek, periodNumber: r.periodNumber, source: 'GENERATED' as const, isLocked: false };
  });
  return { problem, entries };
}
const sameEntries = (a: readonly EditableEntry[], b: readonly EditableEntry[]): boolean => JSON.stringify(a) === JSON.stringify(b);
const mv = (entryId: string, dayOfWeek: string, periodNumber: number, swapWithEntryId?: string): MoveRequest => ({ entryId, to: { dayOfWeek, periodNumber }, ...(swapWithEntryId ? { swapWithEntryId } : {}) });
const rejected = (r: { ok: boolean }): r is { ok: false; status: 400 | 404 | 409; code: string; message: string } => r.ok === false;

// =====================================================================================================================
section('1. Rebuilding the problem from the stored snapshot');
{
  const core = makeCore(3, [5, 4, 3]);
  const problem = problemFromCore(JSON.parse(JSON.stringify(core)), ctx);
  check('the rebuilt problem has the exact core and its hash equals the hash of the core', JSON.stringify(problem.core) === JSON.stringify(core) && problem.inputHash === hashJson(core));
  check('the hash survives key reordering (a JSONB round trip reorders keys)', problemFromCore(reorderKeys(core), ctx).inputHash === hashJson(core) && JSON.stringify(reorderKeys(core)) !== JSON.stringify(core));
  check('derived: 5 days x 6 periods = 30 weekly slots, capacity min(32, 30) = 30', problem.derived.dayCount === 5 && problem.derived.periodsPerDay === 6 && problem.derived.weeklySlots === 30 && problem.derived.teacherCapacity === 30);
  check('derived: counts and the expected number of entries (3 sections x 12 periods)', problem.derived.sectionCount === 3 && problem.derived.teacherCount === 3 && problem.derived.assignmentCount === 9 && problem.derived.expectedEntryCount === 36);
  const big = problemFromCore(makeCore(2, [5], 8, 6), ctx);
  check('derived: 6 days x 8 periods = 48 slots, capacity min(32, 48) = 32', big.derived.weeklySlots === 48 && big.derived.teacherCapacity === 32);
  check('the context (school, academic year) is carried over', problem.schoolId === 'school-1' && problem.academicYear.id === 'year-1');
  const bad: Array<[string, unknown]> = [
    ['null', null], ['a string', 'x'], ['an empty object', {}], ['an unknown extra key', { ...core, surprise: 1 }],
    ['no sections', { ...core, sections: [] }], ['an assignment with a bad period count', { ...core, assignments: [{ ...core.assignments[0], periodsPerWeek: 0 }] }],
    ['a grid without days', { ...core, grid: { ...core.grid, days: [] } }], ['fixedEntries missing', { ...core, fixedEntries: undefined }],
  ];
  for (const [name, value] of bad) {
    let threw = false;
    try { problemFromCore(value, ctx); } catch (e) { threw = e instanceof SnapshotUnusableError; }
    check(`an unusable snapshot (${name}) is rejected with SnapshotUnusableError`, threw);
  }
}

// =====================================================================================================================
section('2. State machine');
{
  const states: VersionStatus[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
  const allowed = new Set(['DRAFT>PUBLISHED', 'PUBLISHED>ARCHIVED']);
  for (const from of states) for (const to of states) check(`transition ${from} -> ${to} is ${allowed.has(`${from}>${to}`) ? 'allowed' : 'refused'}`, canTransition(from, to) === allowed.has(`${from}>${to}`));
  check('ARCHIVED is terminal (no way out)', VERSION_TRANSITIONS.ARCHIVED.length === 0);
  check('only a DRAFT is editable and only a DRAFT can be deleted', isEditableStatus('DRAFT') && !isEditableStatus('PUBLISHED') && !isEditableStatus('ARCHIVED') && canDeleteVersion('DRAFT') && !canDeleteVersion('PUBLISHED') && !canDeleteVersion('ARCHIVED'));
  const years: YearStatus[] = ['DRAFT', 'ACTIVE', 'COMPLETED'];
  for (const y of years) check(`academic year ${y}: editing is ${y === 'COMPLETED' ? 'refused' : 'allowed'} (D1)`, isYearEditable(y) === (y !== 'COMPLETED'));
  // checkMutable: every combination, and the order of the reasons
  for (const v of states) for (const y of years) for (const rev of [3, 4]) {
    const r = checkMutable({ versionStatus: v, yearStatus: y, revision: 3, expectedRevision: rev });
    const expected = v !== 'DRAFT' ? 'VERSION_NOT_DRAFT' : y === 'COMPLETED' ? 'ACADEMIC_YEAR_NOT_EDITABLE' : rev !== 3 ? 'REVISION_CONFLICT' : null;
    check(`checkMutable(${v}, year ${y}, expected revision ${rev} of 3) -> ${expected ?? 'ok'}`, (r?.code ?? null) === expected && (r === null || r.status === 409), String(r?.code));
  }
  check('every refusal code used is a documented stable code', ['VERSION_NOT_DRAFT', 'ACADEMIC_YEAR_NOT_EDITABLE', 'REVISION_CONFLICT'].every((c) => (EDIT_ERROR_CODES as readonly string[]).includes(c)));
}

// =====================================================================================================================
section('3. Move');
{
  const { problem, entries } = timetableOf(makeCore(3, [5, 4, 3]));
  check('the generated fixture is a valid timetable (36 lessons)', validateVersion(problem, entries).valid && entries.length === 36);
  const e0 = entries[0]!;
  const occupied = new Set(entries.filter((e) => e.sectionId === e0.sectionId).map((e) => `${e.dayOfWeek}|${e.periodNumber}`));
  const teacherBusySlots = new Set(entries.filter((e) => e.teacherId === e0.teacherId && e.id !== e0.id).map((e) => `${e.dayOfWeek}|${e.periodNumber}`));
  const freeSlots: Array<[string, number]> = [];
  for (const d of WEEK) for (let p = 1; p <= 6; p++) if (!occupied.has(`${d}|${p}`)) freeSlots.push([d, p]);
  const okSlot = freeSlots.find(([d, p]) => !teacherBusySlots.has(`${d}|${p}`))!;
  const busySlot = freeSlots.find(([d, p]) => teacherBusySlots.has(`${d}|${p}`));

  const r = planMove(problem, entries, mv(e0.id, okSlot[0], okSlot[1]));
  check('moving a lesson to a free slot (section free, teacher free) is accepted as a single change', r.ok && r.plan.mode === 'MOVE' && r.plan.changes.length === 1 && r.plan.changes[0]!.id === e0.id);
  if (r.ok) {
    const after = applyPlan(entries, r.plan);
    check('after the move the timetable is still valid (counts, collisions, capacity)', validateVersion(problem, after).valid);
    const moved = after.find((e) => e.id === e0.id)!;
    check('the lesson is in the new slot, is MANUAL and is NOT auto-locked (D2)', moved.dayOfWeek === okSlot[0] && moved.periodNumber === okSlot[1] && moved.source === 'MANUAL' && moved.isLocked === false);
    check('nothing else changed: same ids, teachers, subjects, sections, requirements; every other entry is identical', after.length === entries.length && after.every((e, i) => e.id === entries[i]!.id && e.teacherId === entries[i]!.teacherId && e.subjectId === entries[i]!.subjectId && e.sectionId === entries[i]!.sectionId && e.subjectRequirementId === entries[i]!.subjectRequirementId && (e.id === e0.id || JSON.stringify(e) === JSON.stringify(entries[i]))));
    check('applying a plan does not mutate its input', entries[0]!.source === 'GENERATED' && entries[0]!.dayOfWeek === e0.dayOfWeek);
    check('manual-edit count goes 0 -> 1 and the lock count stays 0', manualEditCount(entries) === 0 && manualEditCount(after) === 1 && lockedCount(after) === 0);
  }
  if (busySlot) {
    const b = planMove(problem, entries, mv(e0.id, busySlot[0], busySlot[1]));
    check('a slot where the teacher teaches ANOTHER section: 409 TEACHER_BUSY', rejected(b) && b.status === 409 && b.code === 'TEACHER_BUSY');
  } else {
    check('(fixture) a teacher-busy slot exists for the first lesson', false, 'fixture has no teacher-busy free slot');
  }
  const same = entries.find((e) => e.id !== e0.id && e.sectionId === e0.sectionId)!;
  const occ = planMove(problem, entries, mv(e0.id, same.dayOfWeek, same.periodNumber));
  check('a slot the same section already uses: 409 SLOT_OCCUPIED (a swap is the way)', rejected(occ) && occ.status === 409 && occ.code === 'SLOT_OCCUPIED');
  const stay = planMove(problem, entries, mv(e0.id, e0.dayOfWeek, e0.periodNumber));
  check('moving a lesson to the slot it is already in: 400 INVALID_MOVE', rejected(stay) && stay.status === 400 && stay.code === 'INVALID_MOVE');
  for (const [name, day, period] of [['a day outside the working week (SATURDAY)', 'SATURDAY', 1], ['a nonsense day', 'FUNDAY', 1], ['period 0', 'MONDAY', 0], ['period 7 of 6', 'MONDAY', 7], ['a negative period', 'MONDAY', -1], ['a fractional period', 'MONDAY', 1.5], ['NaN', 'MONDAY', Number.NaN]] as const) {
    const bad = planMove(problem, entries, mv(e0.id, day, period));
    check(`${name}: 400 INVALID_SLOT`, rejected(bad) && bad.status === 400 && bad.code === 'INVALID_SLOT');
  }
  const none = planMove(problem, entries, mv('does-not-exist', 'MONDAY', 1));
  check('an unknown entry: 404 ENTRY_NOT_FOUND', rejected(none) && none.status === 404 && none.code === 'ENTRY_NOT_FOUND');
  const locked = entries.map((e) => (e.id === e0.id ? { ...e, isLocked: true } : e));
  const lk = planMove(problem, locked, mv(e0.id, okSlot[0], okSlot[1]));
  check('a locked lesson cannot move: 409 ENTRY_LOCKED', rejected(lk) && lk.status === 409 && lk.code === 'ENTRY_LOCKED');
  check('the invalid slot is reported before the lock (a malformed request is a 400 whatever the state)', (() => { const x = planMove(problem, locked, mv(e0.id, 'SATURDAY', 1)); return rejected(x) && x.code === 'INVALID_SLOT'; })());
  const before = JSON.stringify(entries);
  planMove(problem, entries, mv(e0.id, busySlot?.[0] ?? 'MONDAY', busySlot?.[1] ?? 1));
  check('a refused plan never touches the entries', JSON.stringify(entries) === before);
}

// =====================================================================================================================
section('4. Swap');
{
  const { problem, entries } = timetableOf(makeCore(3, [5, 4, 3]));
  const s1 = entries.filter((e) => e.sectionId === 'sec-1');
  const a = s1[0]!;
  // find a partner whose swap does not hit a teacher collision
  let planned: ReturnType<typeof planMove> | null = null;
  let partner: EditableEntry | null = null;
  for (const b of s1.slice(1)) {
    const p = planMove(problem, entries, mv(a.id, b.dayOfWeek, b.periodNumber, b.id));
    if (p.ok) { planned = p; partner = b; break; }
  }
  check('two lessons of the same section can be swapped (an accepted swap exists in the fixture)', planned !== null && planned.ok && planned.plan.mode === 'SWAP' && planned.plan.changes.length === 2);
  if (planned && planned.ok && partner) {
    const after = applyPlan(entries, planned.plan);
    const na = after.find((e) => e.id === a.id)!;
    const nb = after.find((e) => e.id === partner!.id)!;
    check('each lesson takes the other one\'s slot', na.dayOfWeek === partner.dayOfWeek && na.periodNumber === partner.periodNumber && nb.dayOfWeek === a.dayOfWeek && nb.periodNumber === a.periodNumber);
    check('BOTH lessons become MANUAL; neither is locked', na.source === 'MANUAL' && nb.source === 'MANUAL' && !na.isLocked && !nb.isLocked && manualEditCount(after) === 2);
    check('the timetable is still valid after the swap', validateVersion(problem, after).valid);
    check('the set of occupied slots is unchanged (a swap only exchanges)', JSON.stringify(entries.map((e) => `${e.sectionId}|${e.dayOfWeek}|${e.periodNumber}`).sort()) === JSON.stringify(after.map((e) => `${e.sectionId}|${e.dayOfWeek}|${e.periodNumber}`).sort()));
  }
  const other = entries.find((e) => e.sectionId === 'sec-2')!;
  const cross = planMove(problem, entries, mv(a.id, other.dayOfWeek, other.periodNumber, other.id));
  check('swapping lessons of different sections: 400 INVALID_SWAP', rejected(cross) && cross.status === 400 && cross.code === 'INVALID_SWAP');
  const self = planMove(problem, entries, mv(a.id, a.dayOfWeek, a.periodNumber, a.id));
  check('swapping a lesson with itself: 400 INVALID_SWAP', rejected(self) && self.status === 400 && self.code === 'INVALID_SWAP');
  const b1 = s1[1]!;
  const wrongTo = planMove(problem, entries, mv(a.id, b1.dayOfWeek === 'FRIDAY' ? 'MONDAY' : 'FRIDAY', 6, b1.id));
  check('a target that is not the partner\'s slot: 400 INVALID_SWAP', rejected(wrongTo) && wrongTo.status === 400 && wrongTo.code === 'INVALID_SWAP');
  check('an unknown swap partner: 404 ENTRY_NOT_FOUND', (() => { const x = planMove(problem, entries, mv(a.id, b1.dayOfWeek, b1.periodNumber, 'nope')); return rejected(x) && x.status === 404; })());
  const lockA = entries.map((e) => (e.id === a.id ? { ...e, isLocked: true } : e));
  const lockB = entries.map((e) => (e.id === b1.id ? { ...e, isLocked: true } : e));
  const la = planMove(problem, lockA, mv(a.id, b1.dayOfWeek, b1.periodNumber, b1.id));
  const lb = planMove(problem, lockB, mv(a.id, b1.dayOfWeek, b1.periodNumber, b1.id));
  check('a swap with a locked participant is refused whichever side is locked: 409 ENTRY_LOCKED', rejected(la) && la.code === 'ENTRY_LOCKED' && rejected(lb) && lb.code === 'ENTRY_LOCKED');
  // a swap that would put a teacher in two places: find one
  let teacherBusyFound = false;
  for (const x of s1) for (const y of s1) {
    if (x.id === y.id) continue;
    const p = planMove(problem, entries, mv(x.id, y.dayOfWeek, y.periodNumber, y.id));
    if (rejected(p) && p.code === 'TEACHER_BUSY') { teacherBusyFound = true; }
  }
  check('a swap that would double-book a teacher is refused with 409 TEACHER_BUSY (such a pair exists in the fixture)', teacherBusyFound);
}

// =====================================================================================================================
section('5. A FULL timetable: moving is impossible, swapping works');
{
  // 1 section, 3 teachers, 10 periods each = 30 = every slot of the week
  const { problem, entries } = timetableOf(makeCore(1, [10, 10, 10]));
  check('(fixture) the section is full: 30 lessons in 30 slots, valid', entries.length === 30 && validateVersion(problem, entries).valid);
  const a = entries[0]!;
  const b = entries.find((e) => e.id !== a.id && e.subjectId !== a.subjectId)!;
  const m = planMove(problem, entries, mv(a.id, b.dayOfWeek, b.periodNumber));
  check('moving into any slot is refused: 409 SLOT_OCCUPIED', rejected(m) && m.code === 'SLOT_OCCUPIED');
  const s = planMove(problem, entries, mv(a.id, b.dayOfWeek, b.periodNumber, b.id));
  check('the swap of two lessons of different teachers is accepted', s.ok && s.plan.mode === 'SWAP');
  if (s.ok) {
    const after = applyPlan(entries, s.plan);
    check('and the full timetable stays valid', validateVersion(problem, after).valid);
  }
  // every possible swap pair: whatever the rules say, an ACCEPTED plan must always give a valid timetable
  let accepted = 0;
  let refusedCount = 0;
  let allValid = true;
  for (const x of entries) for (const y of entries) {
    if (x.id === y.id) continue;
    const p = planMove(problem, entries, mv(x.id, y.dayOfWeek, y.periodNumber, y.id));
    if (p.ok) { accepted++; if (!validateVersion(problem, applyPlan(entries, p.plan)).valid) allValid = false; } else refusedCount++;
  }
  check(`exhaustive: all ${accepted + refusedCount} ordered swap pairs: every accepted swap (${accepted}) leaves a valid timetable`, allValid && accepted > 0);
}

// =====================================================================================================================
section('6. Randomised sequences: no accepted edit ever breaks the timetable, no refused edit changes anything');
{
  const rng = ((seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; })(20261008);
  for (const [name, core] of [['sparse (3 sections, 12 of 30 slots)', makeCore(3, [5, 4, 3])], ['dense (3 sections, 28 of 30 slots per section)', makeCore(3, [9, 9, 10])], ['full (2 sections, 30 of 30)', makeCore(2, [10, 10, 10])]] as const) {
    const { problem, entries: start } = timetableOf(core, 11);
    let entries = start;
    let ok = 0;
    let refusedN = 0;
    let broke = '';
    const per = (list: readonly EditableEntry[]) => JSON.stringify([...list].map((e) => `${e.sectionId}|${e.subjectRequirementId}`).sort());
    const countsBefore = per(start);
    for (let step = 0; step < 600 && !broke; step++) {
      const e = entries[Math.floor(rng() * entries.length)]!;
      const isSwap = rng() < 0.5;
      let request: MoveRequest;
      if (isSwap) {
        const mates = entries.filter((x) => x.sectionId === e.sectionId && x.id !== e.id);
        const partner = mates[Math.floor(rng() * mates.length)] ?? e;
        request = mv(e.id, partner.dayOfWeek, partner.periodNumber, partner.id);
      } else {
        request = mv(e.id, WEEK[Math.floor(rng() * 5)]!, 1 + Math.floor(rng() * 6));
      }
      if (rng() < 0.1) entries = entries.map((x) => (x.id === e.id ? { ...x, isLocked: !x.isLocked } : x)); // random lock toggles
      const snapshot = JSON.stringify(entries);
      const plan = planMove(problem, entries, request);
      if (!plan.ok) { refusedN++; if (JSON.stringify(entries) !== snapshot) broke = `refusal mutated entries at step ${step}`; continue; }
      const next = applyPlan(entries, plan.plan);
      const v = validateVersion(problem, next);
      if (!v.valid) { broke = `invalid timetable after an accepted ${plan.plan.mode} at step ${step}: ${JSON.stringify(v.violations.slice(0, 2))}`; break; }
      if (entries.filter((x) => x.isLocked).some((x) => { const n = next.find((y) => y.id === x.id)!; return n.dayOfWeek !== x.dayOfWeek || n.periodNumber !== x.periodNumber; })) { broke = `a locked lesson moved at step ${step}`; break; }
      if (per(next) !== countsBefore) { broke = `weekly counts changed at step ${step}`; break; }
      entries = next;
      ok++;
    }
    check(`${name}: 600 random steps (${ok} accepted, ${refusedN} refused): ${broke || 'always valid, locks respected, counts preserved'}`, broke === '' && ok > 0, broke);
  }
}

// =====================================================================================================================
section('7. Locks');
{
  const { entries } = timetableOf(makeCore(3, [5, 4, 3]));
  const ids = entries.slice(0, 3).map((e) => e.id);
  const lock = planLocks(entries, ids, true);
  check('locking three unlocked entries changes all three', lock.ok && lock.plan.toChange.length === 3 && lock.plan.unchanged.length === 0);
  const locked = entries.map((e) => (ids.includes(e.id) ? { ...e, isLocked: true } : e));
  const again = planLocks(locked, ids, true);
  check('locking them again is idempotent: nothing changes', again.ok && again.plan.toChange.length === 0 && again.plan.unchanged.length === 3);
  const mixed = planLocks(locked, [...ids, entries[5]!.id], true);
  check('a mix: only the not-yet-locked entry changes', mixed.ok && mixed.plan.toChange.length === 1 && mixed.plan.unchanged.length === 3);
  const unlock = planLocks(locked, ids, false);
  check('unlocking locked entries changes all of them', unlock.ok && unlock.plan.toChange.length === 3);
  const unlockFree = planLocks(entries, ids, false);
  check('unlocking entries that are not locked is idempotent', unlockFree.ok && unlockFree.plan.toChange.length === 0);
  const unknown = planLocks(entries, [...ids, 'ghost'], true);
  check('an id that is not an entry of this version: 404 ENTRY_NOT_FOUND, and nothing is planned', rejected(unknown) && unknown.status === 404 && unknown.code === 'ENTRY_NOT_FOUND');
  check('lockedCount counts locked entries', lockedCount(locked) === 3 && lockedCount(entries) === 0);
}

// =====================================================================================================================
section('8. Whole-timetable validation and metrics');
{
  const { problem, entries } = timetableOf(makeCore(3, [5, 4, 3]));
  const v = validateVersion(problem, entries);
  check('a valid timetable: valid, no violations, authoritative metrics present', v.valid && v.violations.length === 0 && v.violationCount === 0 && v.metrics !== null);
  check('the metrics equal the Phase 1 evaluator on the same entries (WEIGHTS_V1)', JSON.stringify(v.metrics) === JSON.stringify(evaluateMetrics(problem, rowsFromEntries(problem, entries).rows)) && v.metrics!.weightsVersion === 'V1');
  const w = v.metrics!;
  check('weightedObjective = sum(term x WEIGHTS_V1)', w.weightedObjective === (Object.keys(WEIGHTS_V1) as Array<keyof typeof WEIGHTS_V1>).reduce((s, k) => s + w.terms[k] * WEIGHTS_V1[k], 0));

  const e0 = entries[0]!;
  const sameSection = entries.find((e) => e.id !== e0.id && e.sectionId === e0.sectionId && e.subjectRequirementId !== e0.subjectRequirementId)!; // a DIFFERENT lesson of the section (the same lesson twice is DUPLICATE_ENTRY)
  const collide = entries.map((e) => (e.id === e0.id ? { ...e, dayOfWeek: sameSection.dayOfWeek, periodNumber: sameSection.periodNumber } : e));
  const c = validateVersion(problem, collide);
  check('two lessons of a section in one slot: invalid, SECTION_COLLISION, metrics null', !c.valid && c.violations.some((x) => x.code === 'SECTION_COLLISION') && c.metrics === null);
  const sameTeacher = entries.find((e) => e.teacherId === e0.teacherId && e.sectionId !== e0.sectionId)!;
  const tc = validateVersion(problem, entries.map((e) => (e.id === sameTeacher.id ? { ...e, dayOfWeek: e0.dayOfWeek, periodNumber: e0.periodNumber } : e)));
  check('a teacher in two sections at once: invalid, TEACHER_COLLISION', !tc.valid && tc.violations.some((x) => x.code === 'TEACHER_COLLISION'));
  const dropped = validateVersion(problem, entries.slice(1));
  check('a missing lesson: invalid (wrong period count / entry count)', !dropped.valid && dropped.violations.some((x) => x.code === 'WRONG_PERIOD_COUNT' || x.code === 'ENTRY_COUNT_MISMATCH'));
  const extra = validateVersion(problem, [...entries, { ...e0, id: 'extra', dayOfWeek: 'MONDAY', periodNumber: 6 }]);
  check('an extra lesson: invalid', !extra.valid);
  const ghost = validateVersion(problem, entries.map((e) => (e.id === e0.id ? { ...e, subjectRequirementId: 'req-ghost' } : e)));
  check('a lesson whose requirement is not in the problem: invalid, UNKNOWN_ASSIGNMENT', !ghost.valid && ghost.violations.some((x) => x.code === 'UNKNOWN_ASSIGNMENT'));
  const wrongTeacher = validateVersion(problem, entries.map((e) => (e.id === e0.id ? { ...e, teacherId: 'tea-3' } : e)));
  check('a lesson taught by a teacher other than the assigned one: invalid (ENTRY_ID_MISMATCH)', !wrongTeacher.valid);
  const outside = validateVersion(problem, entries.map((e) => (e.id === e0.id ? { ...e, periodNumber: 9 } : e)));
  check('a lesson outside the grid: invalid (INVALID_PERIOD)', !outside.valid && outside.violations.some((x) => x.code === 'INVALID_PERIOD'));
  const many = validateVersion(problem, entries.map((e) => ({ ...e, dayOfWeek: 'MONDAY', periodNumber: 1 })));
  check('a hopeless timetable reports a bounded list but the true total', !many.valid && many.violations.length <= 50 && many.violationCount > many.violations.length - 1);

  // metrics delta
  const mover = entries.find((e) => e.sectionId === 'sec-1')!;
  const free = (() => { for (const d of WEEK) for (let p = 1; p <= 6; p++) { if (!entries.some((e) => e.sectionId === mover.sectionId && e.dayOfWeek === d && e.periodNumber === p) && !entries.some((e) => e.teacherId === mover.teacherId && e.dayOfWeek === d && e.periodNumber === p)) return [d, p] as const; } return null; })()!;
  const plan = planMove(problem, entries, mv(mover.id, free[0], free[1]));
  if (plan.ok) {
    const after = validateVersion(problem, applyPlan(entries, plan.plan));
    const d = metricsDelta(v.metrics!, after.metrics!);
    check('metricsDelta: after - before for the objective and every term', d.weightedObjective === after.metrics!.weightedObjective - v.metrics!.weightedObjective && Object.keys(d.terms).length === 5 && Object.entries(d.terms).every(([k, x]) => x === (after.metrics!.terms as Record<string, number>)[k]! - (v.metrics!.terms as Record<string, number>)[k]!));
    check('metricsDelta of identical metrics is all zero', metricsDelta(v.metrics!, v.metrics!).weightedObjective === 0 && Object.values(metricsDelta(v.metrics!, v.metrics!).terms).every((x) => x === 0));
    check('the weights are untouched by editing (WEIGHTS_V1 frozen)', after.metrics!.weightsVersion === 'V1' && JSON.stringify(after.metrics!.weights) === JSON.stringify(WEIGHTS_V1));
  } else check('(fixture) a free slot for the delta test', false);
}

// =====================================================================================================================
section('9. Staleness (strict rule, locks are not configuration)');
{
  const core = makeCore(3, [5, 4, 3]);
  const same = JSON.parse(JSON.stringify(core)) as SolverProblemCore;
  check('identical configuration: not stale', !assessStaleness(core, same).stale && assessStaleness(core, same).reason === 'NONE');
  const lockedCore = { ...same, fixedEntries: [{ assignmentId: 'asg-1-1', dayOfWeek: 'MONDAY', periodNumber: 1 }] } as unknown as SolverProblemCore;
  check('different fixedEntries only: NOT stale (locks are not configuration), and the configuration hash ignores them', !assessStaleness(core, lockedCore).stale && configurationHash(core) === configurationHash(lockedCore));
  check('the generation input hash is unchanged by this: hashJson(core) still covers fixedEntries', hashJson(core) !== hashJson(lockedCore));
  const mutations: Array<[string, (c: SolverProblemCore) => SolverProblemCore]> = [
    ['a section assignment changes teacher', (c) => ({ ...c, assignments: c.assignments.map((a, i) => (i === 0 ? { ...a, teacherId: 'tea-2' } : a)) })],
    ['a requirement changes its periods', (c) => ({ ...c, assignments: c.assignments.map((a, i) => (i === 0 ? { ...a, periodsPerWeek: a.periodsPerWeek + 1 } : a)) })],
    ['a section is added', (c) => ({ ...c, sections: [...c.sections, { id: 'sec-9' }] })],
    ['a working day is added', (c) => ({ ...c, grid: { ...c.grid, days: [...c.grid.days, { index: 5, dayOfWeek: 'SATURDAY' }] } } as unknown as SolverProblemCore)],
    ['a period is added', (c) => ({ ...c, grid: { ...c.grid, periods: [...c.grid.periods, { periodNumber: 7, continuesIntoNext: false }] } })],
    ['a break moves (continuesIntoNext flips)', (c) => ({ ...c, grid: { ...c.grid, periods: c.grid.periods.map((p, i) => (i === 2 ? { ...p, continuesIntoNext: true } : p)) } })],
    ['a teacher disappears', (c) => ({ ...c, teachers: c.teachers.slice(1) })],
  ];
  for (const [name, mutate] of mutations) {
    const r = assessStaleness(core, mutate(same));
    check(`${name}: stale (CONFIGURATION_CHANGED)`, r.stale && r.reason === 'CONFIGURATION_CHANGED');
  }
  const gone = assessStaleness(core, null);
  check('a live configuration that no longer normalizes: stale (CONFIGURATION_NOT_NORMALIZABLE)', gone.stale && gone.reason === 'CONFIGURATION_NOT_NORMALIZABLE');
  check('the configuration hash does not depend on key order', configurationHash(core) === configurationHash(reorderKeys(core) as SolverProblemCore));
}

// =====================================================================================================================
section('10. Publish preconditions (state only; the fresh normalization comes after, under locks)');
{
  const base = { target: { status: 'DRAFT' as VersionStatus, revision: 4 }, yearStatus: 'DRAFT' as YearStatus, currentPublishedId: 'pub-1' as string | null, expectedRevision: 4, expectedPublishedVersionId: 'pub-1' as string | null };
  check('everything matches: publishable', checkPublishable(base) === null);
  check('no published version yet and none expected: publishable', checkPublishable({ ...base, currentPublishedId: null, expectedPublishedVersionId: null }) === null);
  check('target already published: VERSION_NOT_DRAFT', checkPublishable({ ...base, target: { status: 'PUBLISHED', revision: 4 } })?.code === 'VERSION_NOT_DRAFT');
  check('target archived: VERSION_NOT_DRAFT', checkPublishable({ ...base, target: { status: 'ARCHIVED', revision: 4 } })?.code === 'VERSION_NOT_DRAFT');
  check('completed year: ACADEMIC_YEAR_NOT_EDITABLE', checkPublishable({ ...base, yearStatus: 'COMPLETED' })?.code === 'ACADEMIC_YEAR_NOT_EDITABLE');
  check('ACTIVE year: publishable (D1)', checkPublishable({ ...base, yearStatus: 'ACTIVE' }) === null);
  check('stale revision: REVISION_CONFLICT', checkPublishable({ ...base, expectedRevision: 3 })?.code === 'REVISION_CONFLICT');
  check('someone published another version meanwhile: PUBLISHED_CHANGED', checkPublishable({ ...base, currentPublishedId: 'pub-2' })?.code === 'PUBLISHED_CHANGED');
  check('the admin saw a published version but there is none now: PUBLISHED_CHANGED', checkPublishable({ ...base, currentPublishedId: null })?.code === 'PUBLISHED_CHANGED');
  check('the admin saw none but one exists now: PUBLISHED_CHANGED', checkPublishable({ ...base, expectedPublishedVersionId: null })?.code === 'PUBLISHED_CHANGED');
  check('order: a non-draft wins over everything; a stale revision wins over a changed published version', checkPublishable({ ...base, target: { status: 'PUBLISHED', revision: 9 }, yearStatus: 'COMPLETED', expectedRevision: 1, currentPublishedId: 'x' })?.code === 'VERSION_NOT_DRAFT' && checkPublishable({ ...base, expectedRevision: 1, currentPublishedId: 'x' })?.code === 'REVISION_CONFLICT');
  check('every refusal is a 409', ['VERSION_NOT_DRAFT', 'ACADEMIC_YEAR_NOT_EDITABLE', 'REVISION_CONFLICT', 'PUBLISHED_CHANGED'].length === 4 && [checkPublishable({ ...base, expectedRevision: 1 }), checkPublishable({ ...base, currentPublishedId: 'z' })].every((r) => r?.status === 409));
}

// =====================================================================================================================
section('11. Phase 7E: fixed entries in a stored snapshot are HISTORY, not a live constraint');
{
  const core = makeCore(3, [5, 4, 3]);
  const { problem: plain, entries } = timetableOf(core);
  // a version generated from locks carries them in its snapshot
  const e0 = entries[0]!;
  const e1 = entries[12]!;
  const lockedCore = { ...core, fixedEntries: [e0, e1].map((e) => ({ assignmentId: plain.core.assignments.find((a) => a.sectionId === e.sectionId && a.subjectRequirementId === e.subjectRequirementId)!.id, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber })) } as unknown as SolverProblemCore;
  const problem = problemFromCore(JSON.parse(JSON.stringify(lockedCore)), ctx);
  check('the rebuilt problem keeps the stored fixed entries (and a hash that covers them)', problem.core.fixedEntries.length === 2 && problem.inputHash === hashJson(lockedCore) && problem.inputHash !== plain.inputHash);
  check('the unchanged timetable is valid', validateVersion(problem, entries).valid);
  const occ = new Set(entries.filter((e) => e.sectionId === e0.sectionId).map((e) => `${e.dayOfWeek}|${e.periodNumber}`));
  const busy = new Set(entries.filter((e) => e.teacherId === e0.teacherId).map((e) => `${e.dayOfWeek}|${e.periodNumber}`));
  let slot: [string, number] | null = null;
  for (const d of WEEK) for (let p = 1; p <= 6; p++) if (!slot && !occ.has(`${d}|${p}`) && !busy.has(`${d}|${p}`)) slot = [d, p];
  const movedPlan = planMove(problem, entries, mv(e0.id, slot![0], slot![1]));
  check('a lesson that was locked at generation, then unlocked, can be moved (planning is unaffected)', movedPlan.ok);
  if (movedPlan.ok) {
    const after = applyPlan(entries, movedPlan.plan);
    const verdict = validateVersion(problem, after);
    check('...and the result is VALID: the historical fixed entry does not make the edit look invalid', verdict.valid && verdict.violationCount === 0 && verdict.metrics !== null);
    check('...although the Phase 1 validator on the same problem DOES see the lesson as no longer fixed (the check really exists)', validateEntries(problem, rowsFromEntries(problem, after).rows).problems.some((p) => p.code === 'FIXED_ENTRY_VIOLATED'));
  }
  check('validation of an unchanged timetable without any fixed entries is exactly as before', validateVersion(plain, entries).valid);
  check('the staleness hash ignores fixed entries (publishing a version generated from locks is not made stale by them)', configurationHash(problem.core) === configurationHash(plain.core) && !assessStaleness(problem.core, plain.core).stale);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
