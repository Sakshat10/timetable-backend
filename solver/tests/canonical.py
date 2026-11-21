"""Independent evaluator of the Phase 1 CANONICAL metric definitions, written from the specification in
src/modules/timetable-generation/timetable-generation.metrics.ts (not copied from the model). Tests use it to
check that (a) it reproduces the TypeScript golden values and (b) the CP-SAT objective agrees with it.

It works on the plain solver-input dict and a list of entry dicts.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

TERMS = ("teacherRun3", "teacherRun4Plus", "subjectSameDayExcess", "sectionHoles", "dailyLoadExcess")


def evaluate(inp: dict[str, Any], entries: list[dict[str, Any]], weights: dict[str, int] | None = None) -> dict[str, Any]:
    weights = weights or inp["weights"]
    days = inp["grid"]["days"]
    periods = inp["grid"]["periods"]
    D, K = len(days), len(periods)
    W = D * K
    day_of = {d["dayOfWeek"]: d["index"] for d in days}
    cont = [bool(p["continuesIntoNext"]) for p in periods]
    cont[-1] = False

    assignment = {a["id"]: a for a in inp["assignments"]}
    teacher_load: dict[str, int] = defaultdict(int)
    section_demand: dict[str, int] = defaultdict(int)
    for a in inp["assignments"]:
        teacher_load[a["teacherId"]] += a["periodsPerWeek"]
        section_demand[a["sectionId"]] += a["periodsPerWeek"]

    teacher_busy: dict[str, set[tuple[int, int]]] = defaultdict(set)
    section_busy: dict[str, set[tuple[int, int]]] = defaultdict(set)
    lessons: dict[tuple[str, int], int] = defaultdict(int)
    for e in entries:
        d, k = day_of[e["dayOfWeek"]], e["periodNumber"] - 1
        teacher_busy[e["teacherId"]].add((d, k))
        section_busy[e["sectionId"]].add((d, k))
        lessons[(e["assignmentId"], d)] += 1

    run3 = run4 = 0
    daily = 0
    for t, busy in teacher_busy.items():
        if teacher_load[t] < 3:
            continue
        for d in range(D):
            for k in range(K - 2):
                if cont[k] and cont[k + 1] and all((d, k + j) in busy for j in range(3)):
                    run3 += 1
            for k in range(K - 3):
                if cont[k] and cont[k + 1] and cont[k + 2] and all((d, k + j) in busy for j in range(4)):
                    run4 += 1
        cap = math.ceil(teacher_load[t] / D)
        if cap < K:
            for d in range(D):
                daily += max(0, sum(1 for k in range(K) if (d, k) in busy) - cap)

    holes = 0
    for s, demand in section_demand.items():
        if demand >= W:
            continue
        busy = section_busy[s]
        for d in range(D):
            for k in range(K - 1):
                if (d, k + 1) in busy and (d, k) not in busy:
                    holes += 1
        cap = math.ceil(demand / D)
        if cap < K:
            for d in range(D):
                daily += max(0, sum(1 for k in range(K) if (d, k) in busy) - cap)

    spread = 0
    for a in assignment.values():
        p = a["periodsPerWeek"]
        cap = math.ceil(p / D)
        if p >= 2 and cap < K:
            for d in range(D):
                spread += max(0, lessons[(a["id"], d)] - cap)

    terms = {
        "teacherRun3": run3, "teacherRun4Plus": run4, "subjectSameDayExcess": spread,
        "sectionHoles": holes, "dailyLoadExcess": daily,
    }
    return {"terms": terms, "weighted": sum(terms[name] * weights[name] for name in TERMS)}


def hard_problems(inp: dict[str, Any], entries: list[dict[str, Any]]) -> list[str]:
    """Independent check of the hard constraints on a finished timetable. Empty list = valid."""
    problems: list[str] = []
    D, K = len(inp["grid"]["days"]), len(inp["grid"]["periods"])
    W = D * K
    day_of = {d["dayOfWeek"]: d["index"] for d in inp["grid"]["days"]}
    assignment = {a["id"]: a for a in inp["assignments"]}
    cap = {t["id"]: min(t["weeklyCapacity"], W, inp["grid"]["maxTeacherPeriodsPerWeek"]) for t in inp["teachers"]}
    count: dict[str, int] = defaultdict(int)
    section_slots: set[tuple[str, int, int]] = set()
    teacher_slots: set[tuple[str, int, int]] = set()
    teacher_load: dict[str, int] = defaultdict(int)
    for e in entries:
        a = assignment.get(e["assignmentId"])
        if a is None:
            problems.append(f"unknown assignment {e['assignmentId']}")
            continue
        if (e["sectionId"], e["subjectId"], e["teacherId"]) != (a["sectionId"], a["subjectId"], a["teacherId"]):
            problems.append(f"ids differ from assignment {a['id']}")
        if e["dayOfWeek"] not in day_of or not (1 <= e["periodNumber"] <= K):
            problems.append(f"invalid slot {e['dayOfWeek']} P{e['periodNumber']}")
            continue
        slot = (day_of[e["dayOfWeek"]], e["periodNumber"])
        if (a["sectionId"], *slot) in section_slots:
            problems.append(f"section collision {a['sectionId']} {slot}")
        if (a["teacherId"], *slot) in teacher_slots:
            problems.append(f"teacher collision {a['teacherId']} {slot}")
        section_slots.add((a["sectionId"], *slot))
        teacher_slots.add((a["teacherId"], *slot))
        count[a["id"]] += 1
        teacher_load[a["teacherId"]] += 1
    for a in assignment.values():
        if count[a["id"]] != a["periodsPerWeek"]:
            problems.append(f"assignment {a['id']} has {count[a['id']]} != {a['periodsPerWeek']} periods")
    for t, load in teacher_load.items():
        if load > cap[t]:
            problems.append(f"teacher {t} load {load} > {cap[t]}")
    return problems
