"""The CP-SAT model.

Decision variables: one Boolean x[a][slot] per assignment a and weekly slot (slot = day * K + period0). The
teacher of every assignment is already fixed by the backend, so there is no teacher dimension.

Hard constraints (V1):
  H1  sum over slots of x[a][slot] == periodsPerWeek(a)            exact weekly periods
  H2  at most one lesson per section per slot                      no section collision
  H3  at most one lesson per teacher per slot                      no teacher collision, enforced globally
  (H4 - teacher load <= min(weeklyCapacity, W) and section demand <= W - is a constant of the input, checked
   before the model is built; see solve.capacity_certificate.)
  fixedEntries (reserved for locked periods, empty in V1): x == 1.

Soft terms: the CANONICAL definitions of src/modules/timetable-generation/timetable-generation.metrics.ts, not
a reinterpretation. Notation: D days, K periods per day, W = D*K; a period is "busy" for a teacher/section when
it has a lesson; continues[k] says period k+1 follows period k without a break.

  teacherRun3           teachers with weekly load >= 3. For every day and window k..k+2 with continues[k] and
                        continues[k+1]: R3 >= busy[k] + busy[k+1] + busy[k+2] - 2.
  teacherRun4Plus       same teachers. Window k..k+3 with continues[k..k+2]: R4 >= sum(busy) - 3.
  subjectSameDayExcess  assignments with p >= 2; c = ceil(p / D); when c < K: e[a][d] >= lessons(a, d) - c.
  sectionHoles          sections with demand < W. For every day and k = 0..K-2: h >= busy[k+1] - busy[k].
  dailyLoadExcess       teachers with weekly load >= 3 and sections with demand < W; cap = ceil(load / D);
                        when cap < K: z[d] >= periods(d) - cap.

Every soft variable is bounded from below only, so the objective is an upper bound of the canonical objective on
any solution and equals it at an optimum (the objective value on an unconverged solution may carry slack; the
backend recomputes every metric from the entries and treats this number as a diagnostic).

There is deliberately NO solution hint: the constructive baseline lives in the Node orchestration layer and is
never passed to CP-SAT.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ortools.sat.python import cp_model

from .contract import Problem


@dataclass
class BuiltModel:
    model: cp_model.CpModel
    #: x[assignment index][slot]
    x: list[list[Any]]
    problem: Problem
    has_objective: bool
    num_booleans: int
    soft_var_counts: dict[str, int] = field(default_factory=dict)


def teacher_loads(problem: Problem) -> dict[str, int]:
    loads: dict[str, int] = {tid: 0 for tid, _ in problem.teachers}
    for a in problem.assignments:
        loads[a.teacher_id] += a.periods
    return loads


def section_demands(problem: Problem) -> dict[str, int]:
    demand: dict[str, int] = {sid: 0 for sid in problem.sections}
    for a in problem.assignments:
        demand[a.section_id] += a.periods
    return demand


def build_model(problem: Problem) -> BuiltModel:
    D = problem.days
    K = problem.periods_per_day
    W = problem.weekly_slots
    cont = problem.continues
    weights = problem.weights
    assignments = problem.assignments
    model = cp_model.CpModel()
    counter = {"bools": 0}

    def new_bool() -> Any:
        counter["bools"] += 1
        return model.new_bool_var("")

    x = [[new_bool() for _ in range(W)] for _ in assignments]

    # H1: exact weekly periods
    for ai, a in enumerate(assignments):
        model.add(cp_model.LinearExpr.sum(x[ai]) == a.periods)

    by_teacher: dict[str, list[int]] = {}
    by_section: dict[str, list[int]] = {}
    for ai, a in enumerate(assignments):
        by_teacher.setdefault(a.teacher_id, []).append(ai)
        by_section.setdefault(a.section_id, []).append(ai)

    # H2 / H3: no section and no teacher collision
    for groups in (by_section, by_teacher):
        for indices in groups.values():
            if len(indices) > 1:
                for slot in range(W):
                    model.add_at_most_one([x[ai][slot] for ai in indices])

    # locked periods (reserved)
    for ai, d, k in problem.fixed:
        model.add(x[ai][d * K + k] == 1)

    loads = teacher_loads(problem)
    demands = section_demands(problem)
    soft_vars: dict[str, list[Any]] = {name: [] for name in weights}

    def busy_vars(indices: list[int]) -> list[Any]:
        """busy[slot] in {0,1}: the teacher/section has a lesson in that slot (a single lesson is its own variable)."""
        if len(indices) == 1:
            return x[indices[0]]
        row = []
        for slot in range(W):
            b = new_bool()
            model.add(cp_model.LinearExpr.sum([x[ai][slot] for ai in indices]) == b)
            row.append(b)
        return row

    # ---- teachers: runs and daily load ----------------------------------------------------------------------
    wants_runs = weights["teacherRun3"] > 0 or weights["teacherRun4Plus"] > 0
    wants_load = weights["dailyLoadExcess"] > 0
    for tid, _cap in problem.teachers:
        indices = by_teacher.get(tid)
        load = loads[tid]
        if not indices or load < 3 or not (wants_runs or wants_load):
            continue  # canonical rule: teachers with weekly load < 3 take part in no teacher term
        busy = busy_vars(indices)
        for d in range(D):
            base = d * K
            if weights["teacherRun3"] > 0:
                for k in range(K - 2):
                    if cont[k] and cont[k + 1]:
                        v = new_bool()
                        model.add(cp_model.LinearExpr.sum([busy[base + k], busy[base + k + 1], busy[base + k + 2]]) - 2 <= v)
                        soft_vars["teacherRun3"].append(v)
            if weights["teacherRun4Plus"] > 0:
                for k in range(K - 3):
                    if cont[k] and cont[k + 1] and cont[k + 2]:
                        v = new_bool()
                        model.add(cp_model.LinearExpr.sum([busy[base + k + j] for j in range(4)]) - 3 <= v)
                        soft_vars["teacherRun4Plus"].append(v)
        if wants_load:
            cap = -(-load // D)
            if cap < K:
                for d in range(D):
                    v = model.new_int_var(0, K, "")
                    model.add(cp_model.LinearExpr.sum(busy[d * K:(d + 1) * K]) - cap <= v)
                    soft_vars["dailyLoadExcess"].append(v)

    # ---- sections: holes and daily load ----------------------------------------------------------------------
    wants_holes = weights["sectionHoles"] > 0
    for sid in problem.sections:
        indices = by_section.get(sid)
        demand = demands[sid]
        if not indices or demand >= W or not (wants_holes or wants_load):
            continue  # a full section has no freedom: no holes, no balance term
        busy = busy_vars(indices)
        if wants_holes:
            for d in range(D):
                base = d * K
                for k in range(K - 1):
                    v = new_bool()
                    model.add(busy[base + k + 1] - busy[base + k] <= v)
                    soft_vars["sectionHoles"].append(v)
        if wants_load:
            cap = -(-demand // D)
            if cap < K:
                for d in range(D):
                    v = model.new_int_var(0, K, "")
                    model.add(cp_model.LinearExpr.sum(busy[d * K:(d + 1) * K]) - cap <= v)
                    soft_vars["dailyLoadExcess"].append(v)

    # ---- subject spread --------------------------------------------------------------------------------------
    if weights["subjectSameDayExcess"] > 0:
        for ai, a in enumerate(assignments):
            if a.periods < 2:
                continue
            cap = -(-a.periods // D)
            if cap >= K:
                continue  # what the number of days forces is never penalised
            for d in range(D):
                v = model.new_int_var(0, K, "")
                model.add(cp_model.LinearExpr.sum(x[ai][d * K:(d + 1) * K]) - cap <= v)
                soft_vars["subjectSameDayExcess"].append(v)

    variables: list[Any] = []
    coefficients: list[int] = []
    for name, vs in soft_vars.items():
        variables.extend(vs)
        coefficients.extend([weights[name]] * len(vs))
    has_objective = bool(variables)
    if has_objective:
        model.minimize(cp_model.LinearExpr.weighted_sum(variables, coefficients))

    return BuiltModel(
        model=model,
        x=x,
        problem=problem,
        has_objective=has_objective,
        num_booleans=counter["bools"],
        soft_var_counts={name: len(vs) for name, vs in soft_vars.items()},
    )
