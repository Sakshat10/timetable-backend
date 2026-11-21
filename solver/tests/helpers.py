"""Builders and runners shared by the solver tests."""
from __future__ import annotations

import copy
import json
import random
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from timetable_solver.contract import DAYS_OF_WEEK, parse_problem
from timetable_solver.solve import solve

SOLVER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SOLVER_DIR.parent
MAIN = SOLVER_DIR / "main.py"
GOLDEN_FILE = REPO_ROOT / "test-fixtures" / "timetable-generation" / "golden-metrics.json"
TS_CONTRACTS = REPO_ROOT / "src" / "modules" / "timetable-generation" / "timetable-generation.contracts.ts"
TS_DAYS = REPO_ROOT / "src" / "modules" / "schedule-config" / "schedule-config.schema.ts"

#: WEIGHTS_V1 as in the TypeScript contract (tests/test_contract_sync.py fails if this ever drifts)
WEIGHTS_V1 = {"teacherRun3": 3, "teacherRun4Plus": 8, "subjectSameDayExcess": 5, "sectionHoles": 4, "dailyLoadExcess": 2}
TERMS = tuple(WEIGHTS_V1)


def all_continue(K: int) -> list[bool]:
    return [k < K - 1 for k in range(K)]


def options(**over: Any) -> dict[str, Any]:
    base = {"timeLimitSeconds": 30, "seed": 1, "numWorkers": 2, "reproducible": False, "deterministicTimeLimit": None}
    base.update(over)
    return base


def weights_only(term: str, value: int = 1) -> dict[str, int]:
    return {name: (value if name == term else 0) for name in TERMS}


def make_input(
    D: int,
    K: int,
    continues: list[bool],
    tuples: list[tuple[str, str, str, int]],
    *,
    weights: dict[str, int] | None = None,
    opts: dict[str, Any] | None = None,
    fixed: list[tuple[str, int, int]] | None = None,
    teacher_cap: int | None = None,
    request_id: str = "req-1",
) -> dict[str, Any]:
    """tuples: (assignment id, section id, teacher id, periodsPerWeek). fixed: (assignment id, day index, period 1-based)."""
    W = D * K
    cap = teacher_cap if teacher_cap is not None else min(32, W)
    sections = sorted({t[1] for t in tuples})
    teachers = sorted({t[2] for t in tuples})
    return {
        "contractVersion": "1.0",
        "requestId": request_id,
        "options": opts if opts is not None else options(),
        "weightsVersion": "V1",
        "weights": dict(weights if weights is not None else WEIGHTS_V1),
        "grid": {
            "days": [{"index": i, "dayOfWeek": DAYS_OF_WEEK[i]} for i in range(D)],
            "periods": [{"periodNumber": k + 1, "continuesIntoNext": continues[k]} for k in range(K)],
            "maxTeacherPeriodsPerWeek": 32,
        },
        "sections": [{"id": s} for s in sections],
        "teachers": [{"id": t, "weeklyCapacity": cap} for t in teachers],
        "assignments": [
            {"id": aid, "sectionId": s, "subjectId": f"subj-{i}", "subjectRequirementId": f"req-{i}", "teacherId": t, "periodsPerWeek": p}
            for i, (aid, s, t, p) in enumerate(tuples)
        ],
        "fixedEntries": [{"assignmentId": aid, "dayOfWeek": DAYS_OF_WEEK[d], "periodNumber": k} for aid, d, k in (fixed or [])],
    }


def solve_input(inp: dict[str, Any]) -> dict[str, Any]:
    """Validate and solve in-process, with the whole time budget available."""
    return solve(parse_problem(inp), process_start=time.monotonic())


def with_entries_fixed(inp: dict[str, Any], entries: list[dict[str, Any]], weights: dict[str, int] | None = None) -> dict[str, Any]:
    """The same problem with every lesson locked in place: the model can then only choose its soft variables, so
    the optimal objective is exactly the canonical weighted objective of those entries."""
    fixed = copy.deepcopy(inp)
    fixed["fixedEntries"] = [
        {"assignmentId": e["assignmentId"], "dayOfWeek": e["dayOfWeek"], "periodNumber": e["periodNumber"]} for e in entries
    ]
    if weights is not None:
        fixed["weights"] = dict(weights)
    return fixed


def entry_for(inp: dict[str, Any], assignment_id: str, day: int, period: int) -> dict[str, Any]:
    a = next(x for x in inp["assignments"] if x["id"] == assignment_id)
    return {
        "assignmentId": a["id"], "sectionId": a["sectionId"], "subjectId": a["subjectId"], "teacherId": a["teacherId"],
        "dayOfWeek": DAYS_OF_WEEK[day], "periodNumber": period,
    }


def run_cli(payload: Any, *, timeout: float = 120, raw: bytes | None = None) -> tuple[int, Any, str]:
    """Run solver/main.py as a subprocess. Returns (exit code, decoded stdout JSON or None, stderr text)."""
    data = raw if raw is not None else json.dumps(payload).encode("utf-8")
    proc = subprocess.run([sys.executable, str(MAIN)], input=data, capture_output=True, timeout=timeout)
    out = None
    if proc.stdout:
        out = json.loads(proc.stdout.decode("utf-8"))
    return proc.returncode, out, proc.stderr.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# Golden fixtures (exported from the TypeScript side, expected values from the independent Phase 0 evaluator)
# ---------------------------------------------------------------------------
def golden_cases() -> list[dict[str, Any]]:
    return json.loads(GOLDEN_FILE.read_text())["cases"]


def golden_input(case: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    tuples = [(a[0], a[1], a[2], a[3]) for a in case["assignments"]]
    return make_input(case["dayCount"], case["periodsPerDay"], case["continues"], tuples, **kwargs)


def golden_entries(case: dict[str, Any], inp: dict[str, Any]) -> list[dict[str, Any]]:
    return [entry_for(inp, case["assignments"][ai][0], d, k0 + 1) for ai, d, k0 in case["entries"]]


# ---------------------------------------------------------------------------
# Synthetic heavy school (Phase 0 shape): teachers filled to 32, section demand kept within the week
# ---------------------------------------------------------------------------
def synthetic_heavy(n_sections: int, D: int = 5, K: int = 8, seed: int = 5, subjects: int = 10) -> list[tuple[str, str, str, int]]:
    rnd = random.Random(seed)
    W = D * K
    tuples: list[tuple[str, str, str, int]] = []
    demand: dict[str, int] = {}
    for subj in range(subjects):
        idx, load = 1, 0
        for s in range(n_sections):
            p = 1 + rnd.randrange(6)
            if load + p > 32:
                idx, load = idx + 1, 0
            load += p
            tuples.append((f"a-{subj}-{s}", f"S{s:03d}", f"T-{subj}-{idx}", p))
            demand[f"S{s:03d}"] = demand.get(f"S{s:03d}", 0) + p
    return [t for t in tuples if demand[t[1]] <= W]
