// Automatic substitution: the pure coordinated allocator (no database). npx tsx test-auto-substitution-core.ts
import { adjacency, runThrough } from './src/modules/substitution/substitution.core.js';
import { allocateDay, type AllocCover, type AllocTeacher, type AllocWorld, type AssignedDecision, type Decision } from './src/modules/substitution/substitution.allocator.js';
import type { ConsecutivePolicy, SubjectBasis } from './src/modules/substitution/substitution.core.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t: string): void => console.log(`\n── ${t} ──`);

const MATH = 'math';
const SCI = 'sci';
const G8 = 'g8';
interface T { id: string; basis?: Record<string, SubjectBasis>; grade?: boolean; lessons?: number[]; absent?: number[]; unavailable?: number[]; covering?: number[]; active?: boolean; weekly?: number; recent?: number }
const teacher = (t: T): AllocTeacher => ({
  id: t.id, name: t.id, isActive: t.active ?? true,
  absentPeriods: new Set(t.absent ?? []), unavailablePeriods: new Set(t.unavailable ?? []),
  lessonPeriods: new Set(t.lessons ?? []), teachingPeriods: new Set(t.lessons ?? []), coveringPeriods: new Set(t.covering ?? []),
  weeklyLoad: t.weekly ?? 0, recentCovers: t.recent ?? 0,
  basisBySubject: new Map(Object.entries(t.basis ?? {})), gradeEligible: new Set(t.grade ? [`${MATH}|${G8}`, `${SCI}|${G8}`] : []),
});
const world = (ts: T[], allowTemporaryCover = true, breakAfter: number[] = [3], policy: ConsecutivePolicy = 'PREFER_AVOID'): AllocWorld => ({ teachers: ts.map(teacher), continues: () => adjacency(8, breakAfter), allowTemporaryCover, policy });
const cover = (id: string, period: number, subjectId = MATH, absentTeacherId = 'ABS'): AllocCover => ({ id, sectionId: `sec-${id}`, period, subjectId, gradeId: G8, absentTeacherId, yearId: 'y' });
const assigned = (d: Decision[]): AssignedDecision[] => d.filter((x): x is AssignedDecision => x.kind === 'ASSIGN');
const who = (d: Decision[], coverId: string): string | null => assigned(d).find((x) => x.coverId === coverId)?.option.teacherId ?? null;
const P = { math: { [MATH]: 'PRIMARY_LINK' as SubjectBasis } };

section('hard constraints');
{
  const d = allocateDay(world([{ id: 'in', basis: P.math, active: false }, { id: 'abs', basis: P.math, absent: [4] }, { id: 'un', basis: P.math, unavailable: [4] }, { id: 'busy', basis: P.math, lessons: [4] }, { id: 'ok' }]), [cover('c', 4)]);
  check('inactive, absent, unavailable and teaching teachers are excluded; the free unqualified one is used as temporary cover', who(d, 'c') === 'ok' && assigned(d)[0]!.temporaryUnqualified === true);
  const e = assigned(d)[0]!.excludedCounts;
  check('  the exclusion reasons are counted for the explanation', e.INACTIVE === 1 && e.ABSENT === 1 && e.UNAVAILABLE === 1 && e.TEACHING_ANOTHER_LESSON === 1);
  const none = allocateDay(world([{ id: 'in', active: false }, { id: 'abs', absent: [4] }]), [cover('c', 4)]);
  check('nobody free → UNFILLED NO_AVAILABLE_TEACHER, nothing is assigned', none.length === 1 && none[0]!.kind === 'UNFILLED' && (none[0] as any).code === 'NO_AVAILABLE_TEACHER');
  const absentOnly = allocateDay(world([{ id: 'ABS', basis: P.math }]), [cover('c', 4)]);
  check('the absent teacher is never their own substitute', absentOnly[0]!.kind === 'UNFILLED');
  const cov = allocateDay(world([{ id: 'x', basis: P.math, covering: [4] }]), [cover('c', 4)]);
  check('a teacher already covering in that period is excluded', cov[0]!.kind === 'UNFILLED');
}

section('preference order');
{
  check('a subject teacher beats an unqualified free teacher', who(allocateDay(world([{ id: 'a-free' }, { id: 'z-math', basis: P.math }]), [cover('c', 4)]), 'c') === 'z-math');
  check('grade-eligible beats a lighter workload', who(allocateDay(world([{ id: 'light', basis: P.math, weekly: 1 }, { id: 'eligible', basis: P.math, grade: true, weekly: 20 }]), [cover('c', 4)]), 'c') === 'eligible');
  check('lower weekly workload wins when subject and grade are equal', who(allocateDay(world([{ id: 'busy', basis: P.math, weekly: 25 }, { id: 'light', basis: P.math, weekly: 10 }]), [cover('c', 4)]), 'c') === 'light');
  check('fewer consecutive periods wins when workload and cover load are equal (P4 cover: adjacent lesson at P5 loses to one at P8)', who(allocateDay(world([{ id: 'adj', basis: P.math, weekly: 1, lessons: [5] }, { id: 'far', basis: P.math, weekly: 1, lessons: [8] }]), [cover('c', 4)]), 'c') === 'far');
  check('fewer recent covers wins when everything else is equal (fairness)', who(allocateDay(world([{ id: 'a', basis: P.math, recent: 5 }, { id: 'b', basis: P.math, recent: 2 }]), [cover('c', 4)]), 'c') === 'b');
  const four = allocateDay(world([{ id: 'x', basis: P.math, lessons: [5, 6, 7] }]), [cover('c', 4)]);
  check('PREFER_AVOID (default): a teacher who would end with four consecutive periods is used as a LAST RESORT when nobody better is free, and flagged as such', four[0]!.kind === 'ASSIGN' && (four[0] as AssignedDecision).lastResort === true && (four[0] as AssignedDecision).option.runLength === 4);
  check('…but any other free teacher is preferred over that last resort', who(allocateDay(world([{ id: 'x', basis: P.math, lessons: [5, 6, 7] }, { id: 'y' }]), [cover('c', 4)]), 'c') === 'y');
  check('a break after period 3 stops the run: lessons at P1-P3 do not make P4 a four-in-a-row', who(allocateDay(world([{ id: 'x', basis: P.math, lessons: [1, 2, 3] }]), [cover('c', 4)]), 'c') === 'x');
  const noTemp = allocateDay(world([{ id: 'u' }], false), [cover('c', 4)]);
  check('temporary cover not permitted: an unqualified free teacher is not used → UNFILLED NO_QUALIFIED_TEACHER', noTemp[0]!.kind === 'UNFILLED' && (noTemp[0] as any).code === 'NO_QUALIFIED_TEACHER');
  check('  …a qualified one still is', who(allocateDay(world([{ id: 'u' }, { id: 'q', basis: P.math }], false), [cover('c', 4)]), 'c') === 'q');
}

section('coordination: several lessons at once');
{
  const w = world([{ id: 'm1', basis: P.math }, { id: 'm2', basis: P.math }]);
  const d = allocateDay(w, [cover('c1', 2), cover('c2', 2, MATH, 'ABS2')]);
  check('two lessons in the same period get two different teachers (a reservation is made immediately)', assigned(d).length === 2 && who(d, 'c1') !== who(d, 'c2'));
  const three = allocateDay(world([{ id: 'm1', basis: P.math }, { id: 'm2', basis: P.math }]), [cover('c1', 2), cover('c2', 2, MATH, 'B'), cover('c3', 2, MATH, 'C')]);
  check('three lessons, two teachers: two assigned, one left OPEN (not rolled back, not double-booked)', assigned(three).length === 2 && three.filter((x) => x.kind === 'UNFILLED').length === 1);
  const slots = assigned(three).map((x) => `${x.option.teacherId}`);
  check('  and the two assignments are different teachers', new Set(slots).size === 2);
  // scarcity: sci cover only SCM can teach (tier 1); math cover both M and SCM are qualified. Naive period/id order would hand SCM to the math cover.
  const scarce = allocateDay(world([{ id: 'M', basis: P.math }, { id: 'SCM', basis: { [MATH]: 'PRIMARY_LINK', [SCI]: 'PRIMARY_LINK' } }]), [cover('a-math', 2, MATH), cover('z-sci', 2, SCI, 'B')]);
  check('scarce qualified teachers go to the lesson with fewer alternatives: the science lesson gets SCM, the maths lesson gets M', who(scarce, 'z-sci') === 'SCM' && who(scarce, 'a-math') === 'M', JSON.stringify(scarce.map((x) => [x.coverId, (x as any).option?.teacherId])));
  const overlap = allocateDay(world([{ id: 'only', basis: P.math }]), [cover('p2', 2), cover('p3', 3), cover('p6', 6)]);
  check('one teacher may take lessons in DIFFERENT periods but never the same period twice', assigned(overlap).length === 3 && new Set(assigned(overlap).map((x) => x.coverId)).size === 3);
  const fourRun = allocateDay(world([{ id: 'only', basis: P.math }]), [cover('p4', 4), cover('p5', 5), cover('p6', 6), cover('p7', 7)]);
  check('PREFER_AVOID: with a single teacher the fourth consecutive lesson is still assigned (last resort), the earlier ones are not flagged', assigned(fourRun).length === 4 && assigned(fourRun).filter((x) => x.lastResort).length >= 1);
  const fourNever = allocateDay(world([{ id: 'only', basis: P.math }], true, [3], 'NEVER_ALLOW'), [cover('p4', 4), cover('p5', 5), cover('p6', 6), cover('p7', 7)]);
  check('NEVER_ALLOW: the allocator never creates four consecutive periods: three are assigned, the fourth stays OPEN with CONSECUTIVE_PERIODS_NOT_ALLOWED', assigned(fourNever).length === 3 && fourNever.filter((x) => x.kind === 'UNFILLED').length === 1 && (fourNever.find((x) => x.kind === 'UNFILLED') as any).code === 'CONSECUTIVE_PERIODS_NOT_ALLOWED');
  const fair = allocateDay(world([{ id: 'm1', basis: P.math }, { id: 'm2', basis: P.math }]), [cover('c2', 2), cover('c3', 3), cover('c6', 6), cover('c8', 8)]);
  const per = new Map<string, number>(); for (const a of assigned(fair)) per.set(a.option.teacherId, (per.get(a.option.teacherId) ?? 0) + 1);
  check('fair distribution: four lessons between two equal teachers are split 2/2, not 4/0', per.get('m1') === 2 && per.get('m2') === 2, JSON.stringify([...per]));
  const reserved = world([{ id: 'm1', basis: P.math }]);
  allocateDay(reserved, [cover('c', 2)]);
  check('the world records the reservation (cover period, weekly load, recent covers)', reserved.teachers[0]!.coveringPeriods.has(2) && reserved.teachers[0]!.weeklyLoad === 1 && reserved.teachers[0]!.recentCovers === 1);
}

section('four consecutive periods: the three school policies');
{
  const w = (policy: ConsecutivePolicy, ts: T[]) => allocateDay(world(ts, true, [3], policy), [cover('c', 4)]);
  const mc: T = { id: 'mc', basis: P.math, lessons: [5, 6, 7] };
  const free: T = { id: 'zfree' };
  const only = w('NEVER_ALLOW', [mc]);
  check('NEVER_ALLOW, only the four-in-a-row teacher is free: OPEN, CONSECUTIVE_PERIODS_NOT_ALLOWED, the exclusion is counted', only[0]!.kind === 'UNFILLED' && (only[0] as any).code === 'CONSECUTIVE_PERIODS_NOT_ALLOWED' && (only[0] as any).excludedCounts.CONSECUTIVE_NOT_ALLOWED === 1);
  check('NEVER_ALLOW, another free teacher exists: that teacher is used', who(w('NEVER_ALLOW', [mc, free]), 'c') === 'zfree');
  check('PREFER_AVOID, another free teacher exists: the unqualified teacher is preferred over the qualified four-in-a-row one (tier 2 beats tier 3)', who(w('PREFER_AVOID', [mc, free]), 'c') === 'zfree');
  const lone = w('PREFER_AVOID', [mc]);
  check('PREFER_AVOID, nobody else: the last resort is assigned automatically and marked lastResort', lone[0]!.kind === 'ASSIGN' && (lone[0] as AssignedDecision).lastResort === true);
  const allowed = w('ALLOW', [mc, free]);
  check('ALLOW: four in a row is permitted and not a last resort: the qualified teacher wins on subject and is NOT flagged', who(allowed, 'c') === 'mc' && (allowed[0] as AssignedDecision).lastResort === false && (allowed[0] as AssignedDecision).option.tier === 1);
  check('ALLOW: the shorter run is still a late preference between otherwise equal teachers', who(w('ALLOW', [{ id: 'a', basis: P.math, lessons: [5, 6, 7] }, { id: 'b', basis: P.math }]), 'c') === 'b');
  check('a break still ends the run under every policy (P1-P3 then break: P4 starts a new run)', ['ALLOW', 'PREFER_AVOID', 'NEVER_ALLOW'].every((p) => w(p as ConsecutivePolicy, [{ id: 'x', basis: P.math, lessons: [1, 2, 3] }])[0]!.kind === 'ASSIGN'));
  check('three in a row is never a problem under any policy', ['ALLOW', 'PREFER_AVOID', 'NEVER_ALLOW'].every((p) => (w(p as ConsecutivePolicy, [{ id: 'x', basis: P.math, lessons: [5, 6] }])[0] as AssignedDecision).lastResort === false));
}

section('determinism');
{
  const ts: T[] = [{ id: 'a', basis: P.math }, { id: 'b', basis: P.math }, { id: 'c' }, { id: 'd', basis: P.math, weekly: 3 }];
  const cs = [cover('c1', 2), cover('c2', 2, MATH, 'B'), cover('c3', 5, SCI), cover('c4', 6)];
  const run = (teachers: T[], covers: AllocCover[]) => JSON.stringify(allocateDay(world(teachers), covers).map((x) => [x.coverId, (x as any).option?.teacherId ?? (x as any).code]).sort());
  check('the same input gives the same result', run(ts, cs) === run(ts, cs));
  check('the result does not depend on the order the teachers or lessons arrive in', run(ts, cs) === run([...ts].reverse(), [...cs].reverse()));
}
section('property tests (seeded random schools): invariants, determinism, and maximum coverage per period');
{
  let seed = 987654321;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const maxMatching = (opts: number[][], nT: number): number => { const holder = new Array<number>(nT).fill(-1); let n = 0; const go = (k: number, seen: boolean[]): boolean => { for (const t of opts[k]!) { if (seen[t]) continue; seen[t] = true; if (holder[t]! < 0 || go(holder[t]!, seen)) { holder[t] = k; return true; } } return false; }; for (let k = 0; k < opts.length; k++) if (go(k, new Array<boolean>(nT).fill(false))) n++; return n; };
  let invariantFailures = 0; let optimalFailures = 0; let detFailures = 0; let neverFailures = 0;
  for (let it = 0; it < 3000; it++) {
    const nT = 2 + Math.floor(rnd() * 6); const nC = 1 + Math.floor(rnd() * 8);
    const policy = (['ALLOW', 'PREFER_AVOID', 'NEVER_ALLOW'] as const)[Math.floor(rnd() * 3)]!;
    const ts: T[] = Array.from({ length: nT }, (_, i) => ({ id: `t${i}`, basis: rnd() < 0.6 ? P.math : {}, lessons: [1, 2, 3, 4, 5, 6, 7, 8].filter(() => rnd() < 0.3), absent: rnd() < 0.1 ? [2, 3, 4, 5] : [], unavailable: rnd() < 0.1 ? [3, 4, 5, 6] : [], active: rnd() < 0.95, weekly: Math.floor(rnd() * 20), recent: Math.floor(rnd() * 5) }));
    const cs = Array.from({ length: nC }, (_, k) => cover(`c${k}`, 2 + Math.floor(rnd() * 6), rnd() < 0.7 ? MATH : SCI, 'ABS'));
    const mk = (teachers: T[]) => world(teachers, rnd() < 2, [3], policy);
    const w1 = mk(ts); const d1 = allocateDay(w1, cs);
    const d2 = allocateDay(mk([...ts].reverse()), [...cs].reverse());
    const sig = (d: Decision[]) => JSON.stringify(d.map((x) => [x.coverId, x.kind === 'ASSIGN' ? x.option.teacherId : (x as any).code]).sort());
    if (sig(d1) !== sig(d2)) detFailures++;
    const byCover = new Map(cs.map((c) => [c.id, c]));
    const slots = new Set<string>(); let bad = false;
    const finalTeaching = new Map<string, Set<number>>(ts.map((t) => [t.id, new Set((t.lessons ?? []).filter((p) => !(t.absent ?? []).includes(p)))]));
    for (const d of d1) if (d.kind === 'ASSIGN') {
      const c = byCover.get(d.coverId)!; const t = ts.find((x) => x.id === d.option.teacherId)!;
      const key = `${t.id}|${c.period}`;
      if (slots.has(key) || !(t.active ?? true) || (t.absent ?? []).includes(c.period) || (t.unavailable ?? []).includes(c.period) || (t.lessons ?? []).includes(c.period) || t.id === c.absentTeacherId) bad = true;
      slots.add(key); finalTeaching.get(t.id)!.add(c.period);
    }
    if (bad) invariantFailures++;
    if (policy === 'NEVER_ALLOW') for (const d of d1) if (d.kind === 'ASSIGN') { const c = byCover.get(d.coverId)!; const run = runThrough(finalTeaching.get(d.option.teacherId)!, c.period, adjacency(8, [3])); if (run.length >= 4) neverFailures++; }
  }
  check('3000 random schools: no teacher is ever assigned twice in a period, while absent/unavailable/inactive, while teaching, or as their own substitute', invariantFailures === 0, `${invariantFailures}`);
  check('  the outcome never depends on the order teachers and lessons arrive in (deterministic)', detFailures === 0, `${detFailures}`);
  check('  NEVER_ALLOW: no automatic assignment ever ends in four consecutive periods (checked against the final assignments of the whole day)', neverFailures === 0, `${neverFailures}`);
  for (let it = 0; it < 5000; it++) {
    const nT = 2 + Math.floor(rnd() * 5); const nC = 2 + Math.floor(rnd() * 5);
    const opts: number[][] = Array.from({ length: nC }, () => { const o: number[] = []; for (let t = 0; t < nT; t++) if (rnd() < 0.5) o.push(t); return o; });
    const ts: AllocTeacher[] = Array.from({ length: nT }, (_, t) => ({ ...teacher({ id: `t${t}` }) }));
    for (let k = 0; k < nC; k++) for (const t of opts[k]!) (ts[t]!.basisBySubject as Map<string, SubjectBasis>).set(`s${k}`, 'PRIMARY_LINK');
    const covers = opts.map((_, k) => ({ ...cover(`c${k}`, 2, `s${k}`), sectionId: `x${k}` }));
    const d = allocateDay({ teachers: ts, continues: () => adjacency(8, [3]), allowTemporaryCover: false, policy: 'PREFER_AVOID' }, covers);
    if (d.filter((x) => x.kind === 'ASSIGN').length !== maxMatching(opts, nT)) optimalFailures++;
  }
  check('5000 random single-period layouts: the allocator always covers as many lessons as is possible at all (maximum matching; greedy alone missed ~0.5%)', optimalFailures === 0, `${optimalFailures}`);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
