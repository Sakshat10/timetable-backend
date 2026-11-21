"""Run the model and produce a contract-conformant output.

This module never substitutes anything for a missing solution: it reports exactly what CP-SAT said (OPTIMAL,
FEASIBLE, INFEASIBLE, UNKNOWN, MODEL_INVALID) or INPUT_INVALID for a rejected payload. The constructive baseline
and every fallback decision belong to the Node orchestration layer.
"""
from __future__ import annotations

import math
import time
from typing import Any, Callable

import ortools
from ortools.sat.python import cp_model

from .contract import MAX_MESSAGE_LENGTH, MAX_MESSAGES, CONTRACT_VERSION, Options, Problem
from .model import BuiltModel, build_model, section_demands, teacher_loads

#: Time kept back for entry extraction and printing after the solver returns.
RESERVE_SECONDS = 0.25
#: Below this remaining budget the solve is not attempted at all (the answer is UNKNOWN).
MIN_SOLVE_SECONDS = 0.05


def ortools_version() -> str:
    return str(getattr(ortools, "__version__", "unknown"))[:50]


def _clip(messages: list[str]) -> list[str]:
    return [m[:MAX_MESSAGE_LENGTH] for m in messages[:MAX_MESSAGES]]


def build_output(
    request_id: str,
    status: str,
    entries: list[dict[str, Any]],
    *,
    wall_seconds: float,
    options: Options | None,
    stopped_by: str,
    messages: list[str],
    objective_value: float | None = None,
    best_bound: float | None = None,
    num_booleans: int | None = None,
    num_constraints: int | None = None,
    conflicts: int | None = None,
    branches: int | None = None,
) -> dict[str, Any]:
    def finite(value: float | None) -> float | None:
        return float(value) if value is not None and math.isfinite(value) else None

    return {
        "contractVersion": CONTRACT_VERSION,
        "requestId": request_id,
        "status": status,
        "entries": entries,
        "diagnostics": {
            "objectiveValue": finite(objective_value),
            "bestObjectiveBound": finite(best_bound),
            "wallSeconds": round(max(0.0, wall_seconds), 3),
            "numWorkers": options.num_workers if options else 0,
            "seed": options.seed if options else 0,
            "ortoolsVersion": ortools_version(),
            "numBooleans": num_booleans,
            "numConstraints": num_constraints,
            "conflicts": conflicts,
            "branches": branches,
            "stoppedBy": stopped_by,
            "messages": _clip(messages),
        },
    }


def input_invalid_output(request_id: str, messages: list[str], wall_seconds: float) -> dict[str, Any]:
    return build_output(
        request_id, "INPUT_INVALID", [],
        wall_seconds=wall_seconds, options=None, stopped_by="ERROR", messages=messages,
    )


def capacity_certificate(problem: Problem) -> list[str]:
    """Exact certificate for the constant hard check H4. With H1 (exact weekly periods) a teacher whose load
    exceeds min(weeklyCapacity, W, maxTeacherPeriodsPerWeek) - or a section whose demand exceeds W - cannot be
    scheduled at all. An empty list means this check passes (and, by Konig's theorem, a timetable exists
    whenever no locked entry contradicts another)."""
    W = problem.weekly_slots
    lines: list[str] = []
    loads = teacher_loads(problem)
    for tid, capacity in problem.teachers:
        limit = min(capacity, W, problem.max_teacher_periods)
        if loads[tid] > limit:
            lines.append(f"teacher {tid}: {loads[tid]} periods per week exceed the limit of {limit}")
    for sid, demand in section_demands(problem).items():
        if demand > W:
            lines.append(f"section {sid}: {demand} periods per week exceed the {W} weekly slots")
    return lines


def make_parameters(options: Options, remaining_seconds: float) -> dict[str, Any]:
    """The CP-SAT parameters for a run. The number of workers is exactly what the backend asked for: this
    process starts no extra workers or processes of its own."""
    params: dict[str, Any] = {
        "num_workers": options.num_workers,
        "random_seed": options.seed,
        "max_time_in_seconds": remaining_seconds,
        "log_search_progress": False,
    }
    if options.reproducible:
        # Opt-in audit/debug mode: interleaved (deterministic) search with a deterministic-time budget; the
        # wall-clock limit above stays as a backstop. Only verified on one environment and one OR-Tools version.
        params["interleave_search"] = True
        params["max_deterministic_time"] = options.deterministic_time_limit
    return params


#: How close to a limit the solver must have got for that limit to be a plausible cause of the stop. They are deliberately generous:
#: the aim is to NEVER attribute a stop to one limit when the other one might have caused it.
DETERMINISTIC_REACHED_FRACTION = 0.95
WALL_CLOCK_REACHED_FRACTION = 0.9


def _stopped_by(status: Any, options: Options, remaining: float, solver: cp_model.CpSolver) -> str:
    """Why a FEASIBLE / UNKNOWN search ended. CP-SAT does not report which limit stopped it (its response carries no stop reason), so the
    cause is inferred from how close each limit was when the search ended:
      * only the deterministic limit was reached  -> DETERMINISTIC_LIMIT (the only case in which a reproducible run is repeatable)
      * only the wall-clock limit was reached     -> TIME_LIMIT
      * BOTH were reached (a near-simultaneous stop) -> LIMIT_AMBIGUOUS: the evidence cannot say which one ended the search, and it must not
        be reported as a confirmed deterministic stop
      * neither (but the search WAS cut short): TIME_LIMIT without reproducible mode (the wall clock is the only limit that exists),
        LIMIT_AMBIGUOUS with it (either limit may have fired)"""
    if status == cp_model.OPTIMAL:
        return "OPTIMAL"
    if status == cp_model.INFEASIBLE:
        return "INFEASIBLE"
    if status == cp_model.MODEL_INVALID:
        return "ERROR"
    # FEASIBLE or UNKNOWN: the search was cut short by a limit
    det_limit = options.deterministic_time_limit
    deterministic_reached = bool(
        options.reproducible and det_limit is not None
        and solver.response_proto.deterministic_time >= DETERMINISTIC_REACHED_FRACTION * det_limit
    )
    wall_reached = solver.wall_time >= WALL_CLOCK_REACHED_FRACTION * remaining
    if deterministic_reached and wall_reached:
        return "LIMIT_AMBIGUOUS"
    if deterministic_reached:
        return "DETERMINISTIC_LIMIT"
    if wall_reached:
        return "TIME_LIMIT"
    # A search that is neither optimal nor infeasible was CUT SHORT, so a limit fired even though neither measurement reached its threshold
    # (CP-SAT accounts for time a little differently than we do). Without reproducible mode the wall clock is the ONLY limit that exists,
    # so the cause is certain. In reproducible mode either limit may have fired: that is ambiguous, never a confirmed deterministic stop.
    if options.reproducible and det_limit is not None:
        return "LIMIT_AMBIGUOUS"
    return "TIME_LIMIT"


def solve(problem: Problem, *, process_start: float, clock: Callable[[], float] = time.monotonic) -> dict[str, Any]:
    """Solve a validated problem. `process_start` is the monotonic time at which the process began: the time
    limit of the options is the budget of the WHOLE process, so interpreter start-up, validation and model
    construction are charged against it."""
    options = problem.options
    request_id = problem.request_id
    messages: list[str] = []

    def elapsed() -> float:
        return clock() - process_start

    certificate = capacity_certificate(problem)
    if certificate:
        return build_output(
            request_id, "INFEASIBLE", [], wall_seconds=elapsed(), options=options, stopped_by="INFEASIBLE",
            messages=["hard capacity limit violated before solving"] + certificate,
        )

    built: BuiltModel = build_model(problem)
    invalid = built.model.validate()
    num_constraints = len(built.model.proto.constraints)
    common = {"num_booleans": built.num_booleans, "num_constraints": num_constraints}
    if invalid:
        return build_output(
            request_id, "MODEL_INVALID", [], wall_seconds=elapsed(), options=options, stopped_by="ERROR",
            messages=[f"CP-SAT rejected the model: {invalid}"], **common,
        )

    remaining = options.time_limit_seconds - elapsed() - RESERVE_SECONDS
    if remaining < MIN_SOLVE_SECONDS:
        return build_output(
            request_id, "UNKNOWN", [], wall_seconds=elapsed(), options=options, stopped_by="TIME_LIMIT",
            messages=[f"time budget of {options.time_limit_seconds}s exhausted before the solve could start"], **common,
        )

    solver = cp_model.CpSolver()
    for name, value in make_parameters(options, remaining).items():
        setattr(solver.parameters, name, value)
    if options.reproducible:
        messages.append(
            f"reproducible mode: interleave_search, deterministic limit {options.deterministic_time_limit}; "
            "identical results are only verified on one environment and OR-Tools version"
        )

    status = solver.solve(built.model)
    stopped_by = _stopped_by(status, options, remaining, solver)
    if stopped_by == "LIMIT_AMBIGUOUS":
        messages.append(
            "the search ended near BOTH its deterministic limit and its wall-clock limit: it cannot be said which one stopped it, "
            "so this result is not confirmed to be repeatable"
        )
    conflicts, branches = int(solver.num_conflicts), int(solver.num_branches)
    stats = {**common, "conflicts": conflicts, "branches": branches}

    if status == cp_model.MODEL_INVALID:
        return build_output(
            request_id, "MODEL_INVALID", [], wall_seconds=elapsed(), options=options, stopped_by="ERROR",
            messages=messages + ["CP-SAT reported the model as invalid while solving"], **stats,
        )
    if status == cp_model.INFEASIBLE:
        return build_output(
            request_id, "INFEASIBLE", [], wall_seconds=elapsed(), options=options, stopped_by="INFEASIBLE",
            messages=messages + ["CP-SAT proved the model infeasible (for example contradictory fixed entries)"], **stats,
        )
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return build_output(
            request_id, "UNKNOWN", [], wall_seconds=elapsed(), options=options, stopped_by=stopped_by,
            messages=messages + ["no solution found within the budget"], **stats,
        )

    K = problem.periods_per_day
    W = problem.weekly_slots
    entries: list[dict[str, Any]] = []
    for ai, a in enumerate(problem.assignments):
        row = built.x[ai]
        for slot in range(W):
            if solver.boolean_value(row[slot]):
                entries.append({
                    "assignmentId": a.id,
                    "sectionId": a.section_id,
                    "subjectId": a.subject_id,
                    "teacherId": a.teacher_id,
                    "dayOfWeek": problem.day_names[slot // K],
                    "periodNumber": slot % K + 1,
                })
    objective = solver.objective_value if built.has_objective else 0.0
    bound = solver.best_objective_bound if built.has_objective else 0.0
    return build_output(
        request_id, "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE", entries,
        wall_seconds=elapsed(), options=options, stopped_by=stopped_by, messages=messages,
        objective_value=objective, best_bound=bound, **stats,
    )
