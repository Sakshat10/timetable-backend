// The simplified school schedule: working days + teaching periods per day + exactly ONE break (the period it comes after). No clock times.
//   e2e/dashboard/e2e.sh exec node_modules/.bin/tsx test-schedule-simplified-api.ts      (disposable local database ONLY)
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { readFileSync } from 'node:fs';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { SubprocessSolverClient, resolveSolverClientConfig } from './src/modules/timetable-generation/timetable-generation.solver-client.js';
import { createScheduleConfigSchema, updateScheduleConfigSchema } from './src/modules/schedule-config/schedule-config.schema.js';
import { validateSchedule, weeklyTeachingCapacity } from './src/modules/schedule-config/schedule-config.service.js';
import { effectiveSchedule } from './src/modules/schedule-config/schedule-config.effective.js';
import { adjacency, runThrough } from './src/modules/substitution/substitution.core.js';
import { captureLogger, createWorld, destroyWorld, fastConfig, prisma, rawPrisma, ScriptedSolver, seedYear, solution, waitTerminal, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t: string): void => console.log(`\n── ${t} ──`);
const PASSWORD = 'Sched#Simple-2030';
const DAYS7 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
// jsonb does not keep object key order: compare structurally
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => a.localeCompare(b))) : x));
const throws = (fn: () => void): string | null => { try { fn(); return null; } catch (e) { return e instanceof Error ? e.message : 'threw'; } };

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('SCHEDA');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('SCHEDB');
  const worlds: World[] = [worldA, worldB];
  interface Reply { status: number; body: Record<string, any> }
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string | null, payload?: unknown): Promise<Reply> => {
    const res = await app.inject({ method, url, ...(cookie ? { headers: { cookie: `session_token=${cookie}` } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Record<string, any> = {};
    try { body = JSON.parse(res.body); } catch { /* not JSON */ }
    return { status: res.statusCode, body };
  };
  const sessionFor = async (world: World): Promise<string> => {
    const admin = await prisma.admin.findUniqueOrThrow({ where: { id: world.adminId } });
    await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    return (await adminService.loginAdmin({ schoolId: world.schoolId, email: admin.email, password: PASSWORD })).sessionToken;
  };
  const yearN = { n: 0 };
  const newYear = async (world: World, status: 'DRAFT' | 'ACTIVE' = 'DRAFT') => (await prisma.academicYear.create({ data: { schoolId: world.schoolId, name: `Y${++yearN.n}-${Date.now()}`, startDate: new Date('2031-01-01'), endDate: new Date('2031-12-31'), status } })).id;
  const runners: GenerationRunner[] = [];
  let forwardTo: GenerationRunner | null = null;
  registerGenerationRunner({ trigger: () => forwardTo?.trigger() });

  try {
    const tokA = await sessionFor(worldA);
    const tokB = await sessionFor(worldB);

    // ===========================================================================================================
    section('1. Pure rules: validation, capacity, schema');
    let allOk = true;
    let count = 0;
    for (const ppd of [2, 3, 5, 6, 7, 8, 12]) for (let b = 1; b <= ppd - 1; b++) { count++; if (throws(() => validateSchedule({ workingDays: ['MONDAY'], periodsPerDay: ppd, breakAfterPeriod: b })) !== null) allOk = false; }
    check(`every break position 1..ppd-1 is valid for ppd 2,3,5,6,7,8,12 (${count} combinations)`, allOk);
    const bad: Array<[string, number, number]> = [['0', 6, 0], ['= ppd (after the LAST period)', 6, 6], ['> ppd', 6, 7], ['negative', 6, -1], ['fraction', 6, 1.5], ['ppd 1: no room for a break', 1, 1], ['ppd 0', 0, 0], ['ppd 13', 13, 4], ['ppd fraction', 6.5, 3]];
    for (const [name, ppd, b] of bad) check(`invalid: break ${name} → rejected`, throws(() => validateSchedule({ workingDays: ['MONDAY'], periodsPerDay: ppd, breakAfterPeriod: b })) !== null);
    check('no working days / duplicate days → rejected', throws(() => validateSchedule({ workingDays: [], periodsPerDay: 6, breakAfterPeriod: 3 })) !== null && throws(() => validateSchedule({ workingDays: ['MONDAY', 'MONDAY'], periodsPerDay: 6, breakAfterPeriod: 3 })) !== null);
    check('weekly capacity = working days x teaching periods: Mon-Sat x 6 = 36 (the example), Mon-Fri x 8 = 40, 3 days x 5 = 15, 7 x 7 = 49', weeklyTeachingCapacity(6, 6) === 36 && weeklyTeachingCapacity(5, 8) === 40 && weeklyTeachingCapacity(3, 5) === 15 && weeklyTeachingCapacity(7, 7) === 49);
    const id = '00000000-0000-4000-8000-000000000001';
    const parse = (o: object) => createScheduleConfigSchema.safeParse({ academicYearId: id, workingDays: ['MONDAY'], periodsPerDay: 6, breakAfterPeriod: 3, ...o });
    check('schema: the simplified body parses; strings / booleans / null / missing are rejected (strict, no coercion)', parse({}).success && !parse({ periodsPerDay: '6' }).success && !parse({ breakAfterPeriod: '3' }).success && !parse({ breakAfterPeriod: true }).success && !parse({ breakAfterPeriod: null }).success && !createScheduleConfigSchema.safeParse({ academicYearId: id, workingDays: ['MONDAY'], periodsPerDay: 6 }).success);
    check('schema: breakAfterPeriod >= periodsPerDay is a field error on breakAfterPeriod', (() => { const r = parse({ breakAfterPeriod: 6 }); return !r.success && r.error.issues.some((i) => i.path[0] === 'breakAfterPeriod'); })());
    check('schema: the old clock fields (periods, timingEvents) are refused with a clear message', (() => { const a = parse({ periods: [{ periodNumber: 1, startTime: '08:00', endTime: '08:45' }] }); const b = parse({ timingEvents: [] }); return !a.success && !b.success && /Clock times are no longer part of the schedule/.test(a.error.issues[0]!.message); })());
    check('schema (update): needs at least one simplified field; legacy fields refused; academicYearId refused', !updateScheduleConfigSchema.safeParse({}).success && !updateScheduleConfigSchema.safeParse({ periods: [] }).success && !updateScheduleConfigSchema.safeParse({ academicYearId: id, breakAfterPeriod: 2 }).success && updateScheduleConfigSchema.safeParse({ breakAfterPeriod: 2 }).success);

    // ===========================================================================================================
    section('2. POST /api/schedule-configs: 4, 5, 6, 7, 8 periods x day combinations x first / middle / last break');
    const dayCombos: Array<[string, string[]]> = [['Mon-Fri', DAYS7.slice(0, 5) as unknown as string[]], ['Mon-Sat', DAYS7.slice(0, 6) as unknown as string[]], ['Mon/Wed/Fri', ['MONDAY', 'WEDNESDAY', 'FRIDAY']], ['all 7 days', [...DAYS7]], ['Sat+Sun only', ['SATURDAY', 'SUNDAY']]];
    let created = 0; let docsOk = true; let dbClean = true; let firstFail = '';
    for (const ppd of [5, 6, 7, 8]) for (const [dayName, days] of dayCombos) for (const b of [1, Math.ceil(ppd / 2), ppd - 1]) {
      const yearId = await newYear(worldA);
      const r = await call('POST', '/api/schedule-configs', tokA, { academicYearId: yearId, workingDays: [...days].reverse(), periodsPerDay: ppd, breakAfterPeriod: b });
      const d = r.body.data;
      const order = DAYS7.filter((x) => days.includes(x));
      const ok = r.status === 201 && d.periodsPerDay === ppd && d.breakAfterPeriod === b && d.legacy === false && d.weeklyTeachingCapacity === days.length * ppd && d.workingDays.join() === order.join()
        && d.periods.length === ppd && d.periods.every((p: any, i: number) => p.periodNumber === i + 1 && p.startTime === null && p.endTime === null) && d.timingEvents.length === 0
        && d.timeline.length === ppd + 1 && d.timeline[b - 1].kind === 'PERIOD' && d.timeline[b - 1].periodNumber === b && d.timeline[b].kind === 'BREAK' && d.timeline[b].afterPeriodNumber === b;
      const rows = await prisma.$queryRawUnsafe<Array<{ p: bigint; e: bigint }>>(`SELECT (SELECT count(*) FROM schedule_periods WHERE "scheduleConfigId" = '${d?.id}') AS p, (SELECT count(*) FROM schedule_timing_events WHERE "scheduleConfigId" = '${d?.id}') AS e`);
      if (!ok && firstFail === '') firstFail = `${ppd}p ${dayName} break ${b}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
      if (!ok) docsOk = false;
      if (Number(rows[0]?.p) !== 0 || Number(rows[0]?.e) !== 0) dbClean = false;
      created++;
    }
    check(`${created} configurations created (201): document has breakAfterPeriod, legacy=false, weeklyTeachingCapacity, periods without times, no timing events, timeline with ONE break after the right period`, docsOk && created === 60, firstFail);
    check('nothing is written to the legacy tables (no schedule_periods rows, no timing events): clock times cannot even be stored', dbClean);
    const y1 = await newYear(worldA);
    const ex = await call('POST', '/api/schedule-configs', tokA, { academicYearId: y1, workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'], periodsPerDay: 6, breakAfterPeriod: 4 });
    check('the task example: Mon-Sat, 6 periods, break after 4 → capacity 36', ex.status === 201 && ex.body.data.weeklyTeachingCapacity === 36 && ex.body.data.timeline.map((t: any) => t.kind === 'PERIOD' ? `P${t.periodNumber}` : 'BREAK').join() === 'P1,P2,P3,P4,BREAK,P5,P6');

    section('2b. Invalid requests through the API');
    const yb = await newYear(worldA);
    const post = (body: object, tok: string | null = tokA) => call('POST', '/api/schedule-configs', tok, { academicYearId: yb, workingDays: ['MONDAY'], periodsPerDay: 6, breakAfterPeriod: 3, ...body });
    for (const [name, body] of [['break 0', { breakAfterPeriod: 0 }], ['break after the last period', { breakAfterPeriod: 6 }], ['break beyond the day', { breakAfterPeriod: 9 }], ['negative break', { breakAfterPeriod: -2 }], ['fractional break', { breakAfterPeriod: 2.5 }], ['string break', { breakAfterPeriod: '3' }], ['one period a day', { periodsPerDay: 1, breakAfterPeriod: 1 }], ['13 periods', { periodsPerDay: 13 }], ['no break at all', { breakAfterPeriod: undefined }], ['two breaks (array)', { breakAfterPeriod: [2, 4] }]] as Array<[string, object]>) {
      const r = await post(body);
      check(`${name} → 400 and nothing created`, r.status === 400 && (await prisma.scheduleConfig.count({ where: { academicYearId: yb } })) === 0, `${r.status}`);
    }
    const legacyBody = await post({ periods: [{ periodNumber: 1, startTime: '08:00', endTime: '08:45' }], timingEvents: [{ type: 'BREAK', afterPeriodNumber: 3, startTime: '10:00', endTime: '10:15' }] });
    check('the old body (periods with start/end times + timing events) → 400 naming the clock fields', legacyBody.status === 400 && /Clock times are no longer part of the schedule/.test(JSON.stringify(legacyBody.body)));
    check('no session → 401; foreign academic year → 403; unknown year → 404', (await post({}, null)).status === 401 && (await call('POST', '/api/schedule-configs', tokB, { academicYearId: yb, workingDays: ['MONDAY'], periodsPerDay: 6, breakAfterPeriod: 3 })).status === 403 && (await post({ academicYearId: '00000000-0000-4000-8000-0000000000ff' })).status === 404);
    const okOnce = await post({});
    check('a valid body → 201, a second create for the same year → 409', okOnce.status === 201 && (await post({})).status === 409);
    const activeYear = await newYear(worldA, 'ACTIVE');
    check('a non-DRAFT academic year is refused (400, DRAFT only)', (await call('POST', '/api/schedule-configs', tokA, { academicYearId: activeYear, workingDays: ['MONDAY'], periodsPerDay: 6, breakAfterPeriod: 3 })).status === 400);

    section('2c. GET and PATCH');
    const cfgId = okOnce.body.data.id as string;
    const list = await call('GET', `/api/schedule-configs?academicYearId=${yb}`, tokA);
    check('GET ?academicYearId → the one configuration with the simplified fields', list.status === 200 && list.body.data.length === 1 && list.body.data[0].breakAfterPeriod === 3 && (await call('GET', `/api/schedule-configs/${cfgId}`, tokA)).body.data.weeklyTeachingCapacity === 6);
    check('school isolation: another school cannot read (403) or list (403) it', (await call('GET', `/api/schedule-configs/${cfgId}`, tokB)).status === 403 && (await call('GET', `/api/schedule-configs?academicYearId=${yb}`, tokB)).status === 403);
    const patch = (body: object, tok: string | null = tokA) => call('PATCH', `/api/schedule-configs/${cfgId}`, tok, body);
    const p1 = await patch({ breakAfterPeriod: 2 });
    check('PATCH breakAfterPeriod → 200, capacity unchanged', p1.status === 200 && p1.body.data.breakAfterPeriod === 2 && p1.body.data.weeklyTeachingCapacity === 6);
    const p2 = await patch({ periodsPerDay: 8, workingDays: ['MONDAY', 'TUESDAY'], breakAfterPeriod: 7 });
    check('PATCH periodsPerDay + workingDays + break together → merged and valid (2 days x 8 = 16)', p2.status === 200 && p2.body.data.weeklyTeachingCapacity === 16 && p2.body.data.breakAfterPeriod === 7 && p2.body.data.periods.length === 8);
    const p3 = await patch({ periodsPerDay: 5 });
    check('PATCH lowering periodsPerDay below the break (7) → 400, nothing changed', p3.status === 400 && (await call('GET', `/api/schedule-configs/${cfgId}`, tokA)).body.data.periodsPerDay === 8);
    check('PATCH invalid break / empty body / legacy fields / academicYearId → 400', (await patch({ breakAfterPeriod: 8 })).status === 400 && (await patch({})).status === 400 && (await patch({ periods: [] })).status === 400 && (await patch({ timingEvents: [] })).status === 400 && (await patch({ academicYearId: yb, breakAfterPeriod: 2 })).status === 400);
    check('PATCH by another school → 403, without a session → 401', (await patch({ breakAfterPeriod: 2 }, tokB)).status === 403 && (await patch({ breakAfterPeriod: 2 }, null)).status === 401);

    // ===========================================================================================================
    section('3. Legacy configurations stay readable, and convert only when an admin saves the simplified form');
    const lw = await seedYear(worldA, 'legacy', { sections: 2, legacy: true, breakAfter: [3] });
    const lc = (await call('GET', `/api/schedule-configs/${lw.configId}`, tokA)).body.data;
    check('a legacy configuration (NULL break, period rows, one timing event) → legacy=true, breakAfterPeriod null, its stored times and event returned unchanged (read-only history)', lc.legacy === true && lc.breakAfterPeriod === null && lc.periods[0].startTime === '08:00' && lc.periods[0].endTime === '08:50' && lc.timingEvents.length === 1 && lc.timingEvents[0].afterPeriodNumber === 3 && lc.timeline.some((t: any) => t.kind === 'EVENT'));
    const lw2 = await seedYear(worldA, 'legacy2', { sections: 2, breakAfter: [2, 4] });
    const lc2 = (await call('GET', `/api/schedule-configs/${lw2.configId}`, tokA)).body.data;
    check('a legacy configuration with TWO events is also readable (legacy=true, 2 events)', lc2.legacy === true && lc2.timingEvents.length === 2);
    const rowsBefore = Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT (SELECT count(*) FROM schedule_periods WHERE "scheduleConfigId" = '${lw2.configId}') + (SELECT count(*) FROM schedule_timing_events WHERE "scheduleConfigId" = '${lw2.configId}') AS n`))[0]!.n);
    const noBreak = await call('PATCH', `/api/schedule-configs/${lw2.configId}`, tokA, { workingDays: ['MONDAY', 'TUESDAY'] });
    check('PATCH of a legacy configuration WITHOUT breakAfterPeriod → 400 explaining the conversion (nothing guessed)', noBreak.status === 400 && /breakAfterPeriod/.test(JSON.stringify(noBreak.body)));
    const conv = await call('PATCH', `/api/schedule-configs/${lw2.configId}`, tokA, { breakAfterPeriod: 4 });
    const rowsAfter = Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT (SELECT count(*) FROM schedule_periods WHERE "scheduleConfigId" = '${lw2.configId}') + (SELECT count(*) FROM schedule_timing_events WHERE "scheduleConfigId" = '${lw2.configId}') AS n`))[0]!.n);
    check('PATCH with breakAfterPeriod converts it: legacy=false, no times in the document', conv.status === 200 && conv.body.data.legacy === false && conv.body.data.breakAfterPeriod === 4 && conv.body.data.periods.every((p: any) => p.startTime === null) && conv.body.data.timingEvents.length === 0);
    check('...and the stored legacy rows are NOT deleted or rewritten (history kept)', rowsAfter === rowsBefore && rowsBefore > 0, `${rowsBefore} → ${rowsAfter}`);

    // ===========================================================================================================
    section('4. The engine reads period numbers and the break position only');
    const eff = (breakAfterPeriod: number | null, ppd: number, events: number[] = []) => effectiveSchedule({ periodsPerDay: ppd, breakAfterPeriod, days: [{ dayOfWeek: 'MONDAY' }], timingEvents: events.map((afterPeriodNumber) => ({ afterPeriodNumber })) });
    check('effectiveSchedule: simplified → periods 1..n, ONE break position, capacity; the legacy event list is ignored', JSON.stringify(eff(4, 6, [1, 2]).breakPositions) === '[4]' && eff(4, 6).periods.length === 6 && eff(4, 6).legacy === false);
    check('effectiveSchedule: legacy → the stored event positions (distinct, sorted), legacy=true', JSON.stringify(eff(null, 8, [5, 3, 3]).breakPositions) === '[3,5]' && eff(null, 8).legacy === true && eff(null, 8).breakPositions.length === 0);
    const sol = new ScriptedSolver((ctx) => solution(ctx.problem));
    const makeRunner = (solver: ConstructorParameters<typeof GenerationRunner>[0]['solverClient']): GenerationRunner => { const { logger } = captureLogger(); const r = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 30 }, logger }); runners.push(r); return r; };
    const scripted = makeRunner(sol);
    forwardTo = scripted;
    scripted.start();
    const startGen = async (yearId: string) => call('POST', '/api/timetable-generations', tokA, { academicYearId: yearId });
    let genOk = true; let gens = 0; let genFail = '';
    for (const [ppd, days, brk] of [[5, 5, 1], [5, 6, 4], [6, 5, 3], [6, 6, 4], [7, 5, 6], [7, 3, 1], [8, 5, 7], [8, 6, 4]] as Array<[number, number, number]>) {
      const y = await seedYear(worldA, `gen${ppd}x${days}b${brk}`, { sections: 2, days, periodsPerDay: ppd, breakAfter: [brk] });
      const before = sol.calls.length;
      const r = await startGen(y.yearId);
      if (r.status !== 202) { genOk = false; genFail = `${ppd}p ${days}d break ${brk}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`; continue; }
      const run = await waitTerminal(r.body.data.generationRunId, 60_000);
      const input = sol.calls[before]?.input;
      const flags = input?.grid.periods.map((p) => p.continuesIntoNext) ?? [];
      const expected = Array.from({ length: ppd }, (_, i) => i + 1 < ppd && i + 1 !== brk);
      const entries = run.versionId ? await prisma.timetableEntry.findMany({ where: { versionId: run.versionId } }) : [];
      const v = run.versionId ? await prisma.timetableVersion.findUnique({ where: { id: run.versionId } }) : null;
      const perSection = new Map<string, number>(); for (const e of entries) perSection.set(e.sectionId, (perSection.get(e.sectionId) ?? 0) + 1);
      const ok = run.status === 'SUCCEEDED' && JSON.stringify(flags) === JSON.stringify(expected) && input?.grid.periods.length === ppd && input?.grid.days.length === days
        && entries.every((e) => e.periodNumber >= 1 && e.periodNumber <= ppd) && [...perSection.values()].every((n) => n === 12) && v !== null && Array.isArray(v.periodTimes) && (v.periodTimes as unknown[]).length === 0 && v.periodTimesCapturedAt !== null
        && JSON.stringify(v.inputSnapshot).includes('continuesIntoNext') && !JSON.stringify(v.inputSnapshot).includes('startMinute');
      if (!ok) { genOk = false; genFail = `${ppd}p ${days}d break ${brk}: status ${run.status} ${run.failureCode ?? ''} flags ${JSON.stringify(flags)} vs ${JSON.stringify(expected)}`; }
      gens++;
    }
    check(`${gens} generations (5-8 periods, 3-6 working days, first / middle / last break): the solver input carries 1..N periods with continuesIntoNext false ONLY at the break and the last period; every lesson is in periods 1..N; no clock times anywhere in the stored version`, genOk && gens === 8, genFail);

    section('5. Weekly capacity, the break is not a lesson, teacher workload');
    const capCases: Array<[number, number]> = [[5, 5], [6, 6], [7, 3], [8, 6]];
    let capOk = true; let capFail = '';
    for (const [ppd, days] of capCases) {
      const y = await seedYear(worldA, `cap${ppd}x${days}`, { sections: 2, days, periodsPerDay: ppd, breakAfter: [Math.max(1, ppd - 2)] });
      const f = (await call('GET', `/api/timetable-feasibility?academicYearId=${y.yearId}`, tokA)).body.data;
      const slots = days * ppd;
      const ok = f.summary.weeklySlots === slots && f.summary.periodsPerDay === ppd && f.limits.weeklySlots === slots && f.limits.effectiveTeacherCapacity === Math.min(32, slots) && f.summary.workingDays === days;
      if (!ok) { capOk = false; capFail = `${ppd}x${days}: ${JSON.stringify({ s: f.summary, l: f.limits }).slice(0, 300)}`; }
    }
    check('feasibility: weeklySlots = days x periods (the break adds none) and a teacher\'s capacity = min(32, slots), for 5x5, 6x6, 7x3, 8x6', capOk, capFail);
    const tight = await seedYear(worldA, 'tight', { sections: 1, days: 3, periodsPerDay: 5, breakAfter: [2], subjects: [8, 4, 3] });
    const tf = (await call('GET', `/api/timetable-feasibility?academicYearId=${tight.yearId}`, tokA)).body.data;
    check('3 working days x 5 periods = 15 weekly slots (the break is not a slot), and a teacher\'s capacity is 15', tf.limits.effectiveTeacherCapacity === 15 && tf.summary.weeklySlots === 15);
    const over = await seedYear(worldA, 'over', { sections: 1, days: 3, periodsPerDay: 5, breakAfter: [2], subjects: [16] });
    const of = (await call('GET', `/api/timetable-feasibility?academicYearId=${over.yearId}`, tokA)).body.data;
    check('demand above the weekly slots (16 > 3x5) is reported as an error: a break position cannot create capacity', of.status === 'NOT_READY' && of.errors.length > 0, JSON.stringify(of.errors?.map((e: any) => e.code)));

    // ===========================================================================================================
    section('6. A REAL solver run on a simplified schedule (Mon-Sat x 6 periods, break after 4)');
    const real = makeRunner(new SubprocessSolverClient(resolveSolverClientConfig(process.env)));
    forwardTo = real;
    real.start();
    const ry = await seedYear(worldA, 'real', { sections: 3, days: 6, periodsPerDay: 6, breakAfter: [4], subjects: [6, 5, 4] });
    const rr = await call('POST', '/api/timetable-generations', tokA, { academicYearId: ry.yearId, options: { seed: 7, reproducible: true } });
    const rrun = await waitTerminal(rr.body.data.generationRunId, 120_000);
    const rEntries = rrun.versionId ? await prisma.timetableEntry.findMany({ where: { versionId: rrun.versionId } }) : [];
    check('the real CP-SAT solver accepts the simplified input and returns a timetable (SUCCEEDED, 3 sections x 15 lessons)', rrun.status === 'SUCCEEDED' && rEntries.length === 45, `${rrun.status} ${rrun.failureCode ?? ''} ${rEntries.length}`);
    check('every lesson is in periods 1..6 of Mon-Sat; no section or teacher double-booked; the break (between 4 and 5) holds no lesson and no extra period exists', rEntries.every((e) => e.periodNumber >= 1 && e.periodNumber <= 6 && e.dayOfWeek !== 'SUNDAY') && new Set(rEntries.map((e) => `${e.sectionId}|${e.dayOfWeek}|${e.periodNumber}`)).size === 45 && new Set(rEntries.map((e) => `${e.teacherId}|${e.dayOfWeek}|${e.periodNumber}`)).size === rEntries.length);
    const rVersion = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: rrun.versionId! } });
    const rFlags = ((rVersion.inputSnapshot as any).grid.periods as Array<{ periodNumber: number; continuesIntoNext: boolean }>).map((p) => p.continuesIntoNext);
    check('the stored version snapshot says the run is interrupted exactly at the break: periods 4 and 6 do not continue', JSON.stringify(rFlags) === JSON.stringify([true, true, true, false, true, false]));
    const m = (rVersion.metrics as any).informational;
    check('workload metrics are computed from the break position (teacherMaxRun counts runs of consecutive periods split at the break: at most 4 inside periods 1-4)', typeof m.teacherMaxRun === 'number' && m.teacherMaxRun <= 4, `teacherMaxRun ${m.teacherMaxRun}`);
    real.stop(5).catch(() => undefined);
    forwardTo = scripted;

    // ===========================================================================================================
    section('7. Substitution period indexing follows the break position');
    const set = (...n: number[]) => new Set(n);
    const runOf = (teaching: number[], period: number, ppd: number, breaks: number[]) => runThrough(new Set(teaching), period, adjacency(ppd, breaks));
    const same = (r: { from: number; to: number; length: number }, from: number, to: number) => r.from === from && r.to === to && r.length === to - from + 1;
    check('simplified, break after 4 of 8: lessons in P2,P3,P4 + a cover in P5 → the run is only P5 (the break interrupts; P4 is not joined)', same(runOf([2, 3, 4, 5], 5, 8, eff(4, 8).breakPositions), 5, 5));
    check('...and a cover in P4 joins P2-P4 (3 in a row) because there is no break before P4', same(runOf([2, 3, 4], 4, 8, eff(4, 8).breakPositions), 2, 4));
    check('break after 7 of 8: lessons P1-P4 and P6-P7 + a cover in P5 → one run P1..P7 (7 consecutive teaching periods, the break is later)', same(runOf([1, 2, 3, 4, 5, 6, 7], 5, 8, eff(7, 8).breakPositions), 1, 7));
    check('break after the FIRST period: P1 | P2..P6 → a run starting at P2 is not joined to P1', same(runOf([1, 2, 3], 2, 6, eff(1, 6).breakPositions), 2, 3));
    check('break after the LAST valid position (5 of 6): P1..P5 | P6 → P6 is alone', same(runOf([4, 5, 6], 6, 6, eff(5, 6).breakPositions), 6, 6) && same(runOf([4, 5, 6], 5, 6, eff(5, 6).breakPositions), 4, 5));
    check('legacy and simplified give identical run lengths for the same break position', JSON.stringify(runThrough(set(2, 3, 4, 5), 5, adjacency(8, eff(null, 8, [4]).breakPositions))) === JSON.stringify(runThrough(set(2, 3, 4, 5), 5, adjacency(8, eff(4, 8).breakPositions))));

    // ===========================================================================================================
    section('8. Historical versions stay readable: legacy snapshot with times, no snapshot, and the new "no times by design"');
    const hy = await seedYear(worldA, 'hist', { sections: 2, days: 5, periodsPerDay: 6, breakAfter: [3], legacy: true });
    forwardTo = scripted;
    const mk = async (): Promise<string> => {
      const r = await call('POST', '/api/timetable-generations', tokA, { academicYearId: hy.yearId, options: { seed: 3 } });
      return (await waitTerminal(r.body.data.generationRunId, 60_000)).versionId!;
    };
    const vNew = await mk();
    const vOldSnap = await mk();
    const vOldNone = await mk();
    const times = Array.from({ length: 6 }, (_, k) => ({ periodNumber: k + 1, startMinute: 480 + k * 60, endMinute: 530 + k * 60 }));
    // The two OLD versions are written the way the code before this change wrote them: a non-empty snapshot, and NULL (before 7F-0).
    await prisma.$executeRawUnsafe(`UPDATE timetable_versions SET "periodTimes" = '${JSON.stringify(times)}'::jsonb, "periodTimesCapturedAt" = now() WHERE id = '${vOldSnap}'`);
    await prisma.$executeRawUnsafe(`UPDATE timetable_versions SET "periodTimes" = NULL, "periodTimesCapturedAt" = NULL WHERE id = '${vOldNone}'`);
    const section0 = hy.sectionIds[0]!;
    const view = async (v: string, q = '') => call('GET', `/api/timetable-versions/${v}/timetable?view=section&id=${section0}${q}`, tokA);
    const vn = await view(vNew); const vs = await view(vOldSnap); const vu = await view(vOldNone);
    check('a NEW version (made now): periodTimes.source NONE, incomplete=false, every period has null startTime/endTime/startMinute/endMinute, continuesIntoNext intact', vn.status === 200 && vn.body.data.periodTimes.source === 'NONE' && vn.body.data.periodTimes.incomplete === false && vn.body.data.grid.periods.every((p: any) => p.startTime === null && p.endTime === null && p.startMinute === null && p.endMinute === null) && vn.body.data.grid.periods.map((p: any) => p.continuesIntoNext).join() === 'true,true,false,true,true,false');
    check('an OLD version with a stored clock snapshot: source SNAPSHOT, the times (08:00-08:50) still shown exactly as stored', vs.status === 200 && vs.body.data.periodTimes.source === 'SNAPSHOT' && vs.body.data.grid.periods[0].startTime === '08:00' && vs.body.data.grid.periods[0].endTime === '08:50' && vs.body.data.grid.periods[5].startTime === '13:00');
    check('a version from before snapshots existed (NULL): source UNAVAILABLE (as before), no times invented', vu.status === 200 && vu.body.data.periodTimes.source === 'UNAVAILABLE' && vu.body.data.grid.periods.every((p: any) => p.startTime === null));
    check('?periodTimes=current: an OLD snapshot version can still be compared with the live legacy rows (CURRENT); a NEW version ignores it (NONE)', (await view(vOldSnap, '&periodTimes=current')).body.data.periodTimes.source === 'CURRENT' && (await view(vNew, '&periodTimes=current')).body.data.periodTimes.source === 'NONE');
    check('the stored snapshot of an old version is byte-for-byte unchanged by reading it; the new version stores [] (not NULL)', canon((await prisma.timetableVersion.findUniqueOrThrow({ where: { id: vOldSnap } })).periodTimes) === canon(times) && canon((await prisma.timetableVersion.findUniqueOrThrow({ where: { id: vNew } })).periodTimes) === '[]');
    // published + archived history
    const pub = (v: string, expected: string | null) => call('POST', `/api/timetable-versions/${v}/publish`, tokA, { expectedRevision: 1, expectedPublishedVersionId: expected });
    const p1x = await pub(vOldSnap, null);
    const p2x = await pub(vNew, vOldSnap);
    check('the old clock-snapshot version can be published, then archived by publishing the new one (normal workflow, history intact)', p1x.status === 200 && p2x.status === 200 && p2x.body.data.archivedVersionId === vOldSnap);
    const arch = await view(vOldSnap);
    check('the ARCHIVED old version is still readable with its original clock times; the PUBLISHED new one reads with NONE', arch.status === 200 && arch.body.data.version.status === 'ARCHIVED' && arch.body.data.periodTimes.source === 'SNAPSHOT' && arch.body.data.grid.periods[0].startTime === '08:00' && (await view(vNew)).body.data.version.status === 'PUBLISHED');
    const clone = await call('POST', `/api/timetable-versions/${vOldSnap}/clone`, tokA, { lockMode: 'NONE', includeStaleness: false });
    const cloneId = clone.body.data?.versionId ?? clone.body.data?.id ?? clone.body.data?.version?.id;
    check('cloning an old version keeps its snapshot exactly (nothing is rewritten)', clone.status === 201 && cloneId !== undefined && canon((await prisma.timetableVersion.findUniqueOrThrow({ where: { id: cloneId } })).periodTimes) === canon(times), JSON.stringify(clone.body).slice(0, 200));

    // ===========================================================================================================
    section('9. Export / client compatibility: shapes the frontend already reads');
    const sc = (await call('GET', `/api/schedule-configs/${okOnce.body.data.id}`, tokA)).body.data;
    check('schedule config keeps id, academicYearId, periodsPerDay, workingDays, periods[], timingEvents[], timeline[], createdAt, updatedAt (times null / empty) and ADDS breakAfterPeriod, weeklyTeachingCapacity, legacy', ['id', 'academicYearId', 'periodsPerDay', 'workingDays', 'periods', 'timingEvents', 'timeline', 'createdAt', 'updatedAt', 'breakAfterPeriod', 'weeklyTeachingCapacity', 'legacy'].every((k) => k in sc));
    check('timetable view keeps version, subject, grid{days,periods{periodNumber,continuesIntoNext,startMinute,endMinute,startTime,endTime}}, periodTimes, cells, totals (times simply null)', ['version', 'subject', 'grid', 'periodTimes', 'cells', 'totals'].every((k) => k in vn.body.data) && ['periodNumber', 'continuesIntoNext', 'startMinute', 'endMinute', 'startTime', 'endTime'].every((k) => k in vn.body.data.grid.periods[0]));
    const teacherView = await call('GET', `/api/timetable-versions/${vNew}/timetable?view=teacher&id=${hy.teacherIds[0]}`, tokA);
    check('the teacher view works on a no-times version as well (200, NONE)', teacherView.status === 200 && teacherView.body.data.periodTimes.source === 'NONE');
    const versionsList = await call('GET', `/api/timetable-versions?academicYearId=${hy.yearId}&includeStaleness=true`, tokA);
    check('version list (published / archived / draft) still answers with staleness', versionsList.status === 200 && versionsList.body.data.length >= 3);

    // ===========================================================================================================
    section('10. Migration backfill (the SQL of migration 20261117090000, run on test rows inside a rolled-back transaction)');
    const sqlText = readFileSync('prisma/migrations/20261117090000_add_schedule_break_after_period/migration.sql', 'utf8');
    const backfill = sqlText.slice(sqlText.indexOf('UPDATE "schedule_configs"'));
    class Rollback extends Error {}
    const results: Record<string, number | null> = {};
    try {
      await rawPrisma.$transaction(async (tx) => {
        const school = await tx.school.create({ data: { name: 'mig', code: `MIG_${Date.now()}` } });
        const mkCfg = async (name: string, ppd: number, events: number[]) => {
          const y = await tx.academicYear.create({ data: { schoolId: school.id, name, startDate: new Date('2032-01-01'), endDate: new Date('2032-12-31') } });
          const c = await tx.scheduleConfig.create({ data: { academicYearId: y.id, periodsPerDay: ppd } });
          for (const e of events) await tx.scheduleTimingEvent.create({ data: { scheduleConfigId: c.id, eventType: 'BREAK', afterPeriodNumber: e, startMinute: 600, endMinute: 610 } });
          return c.id;
        };
        const ids = { none: await mkCfg('none', 6, []), one: await mkCfg('one', 6, [3]), first: await mkCfg('first', 6, [1]), last: await mkCfg('last', 6, [5]), zero: await mkCfg('zero', 6, [0]), end: await mkCfg('end', 6, [6]), two: await mkCfg('two', 6, [2, 4]), twoSame: await mkCfg('twoSame', 6, [3, 3]) };
        await tx.$executeRawUnsafe(backfill);
        for (const [k, cid] of Object.entries(ids)) results[k] = (await tx.scheduleConfig.findUniqueOrThrow({ where: { id: cid } })).breakAfterPeriod;
        const events = await tx.scheduleTimingEvent.count({ where: { scheduleConfig: { academicYear: { schoolId: school.id } } } });
        results.eventsKept = events;
        throw new Rollback();
      });
    } catch (e) { if (!(e instanceof Rollback)) throw e; }
    check('backfill: exactly ONE event after a teaching period → that position (3, first=1, last=5)', results.one === 3 && results.first === 1 && results.last === 5);
    check('backfill: AMBIGUOUS configurations stay NULL (legacy): no event, two events, two events at one position, event before period 1 or after the last period', results.none === null && results.two === null && results.twoSame === null && results.zero === null && results.end === null);
    check('backfill never deletes a timing event (8 configs, 9 events → still 9... counted inside the transaction)', results.eventsKept === 0 + 0 + 1 + 1 + 1 + 1 + 1 + 2 + 2, String(results.eventsKept));
    const cons = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_constraint WHERE conname = 'schedule_configs_breakAfterPeriod_check'`);
    check('the CHECK constraint exists: a break outside 1..periodsPerDay-1 cannot be stored', Number(cons[0]!.n) === 1 && await (async () => { try { await prisma.$executeRawUnsafe(`UPDATE schedule_configs SET "breakAfterPeriod" = "periodsPerDay" WHERE id = '${cfgId}'`); return false; } catch { return true; } })());
  } finally {
    for (const r of runners) await r.stop(5).catch(() => undefined);
    registerGenerationRunner(null);
    for (const w of worlds) await destroyWorld(w);
    await app.close();
    await rawPrisma.$disconnect();
  }
  console.log(`\nRESULT: pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
