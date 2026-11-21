"""Strict validation of the solver input and output.

Mirrors the Zod schemas of src/modules/timetable-generation/timetable-generation.contracts.ts (the source of
truth; tests/test_contract_sync.py fails if the constants below drift from it). Every object is strict: all fields
are required and unknown fields are rejected, exactly like z.strictObject. JSON numbers have no int/float
distinction in JavaScript, so an integral float such as 3.0 counts as an integer, as it does for Zod.

On top of the schema it enforces the cross-reference integrity the model relies on (unique ids, assignments that
point at known sections and teachers, a consistent grid). It does NOT enforce problem properties such as
capacity: an overloaded teacher is an INFEASIBLE problem, not a malformed payload.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

CONTRACT_VERSION = "1.0"

DAYS_OF_WEEK = ("MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY")
SOLVER_STATUSES = ("OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN", "MODEL_INVALID", "INPUT_INVALID")
STOPPED_BY = ("OPTIMAL", "TIME_LIMIT", "DETERMINISTIC_LIMIT", "INFEASIBLE", "ERROR", "NONE", "LIMIT_AMBIGUOUS")
TERM_NAMES = ("teacherRun3", "teacherRun4Plus", "subjectSameDayExcess", "sectionHoles", "dailyLoadExcess")

MAX_TEACHER_PERIODS_PER_WEEK = 32
MAX_SECTIONS = 2_000
MAX_TEACHERS = 5_000
MAX_ASSIGNMENTS = 50_000
MAX_ENTRIES = 500_000
MAX_WORKERS = 64
MAX_TIME_LIMIT_CEILING = 3_600
MAX_ID_LENGTH = 100
MAX_SAFE_INTEGER = 2**53 - 1
MAX_REPORTED_ERRORS = 20
MAX_MESSAGE_LENGTH = 500
MAX_MESSAGES = 50


class ContractError(Exception):
    """The payload violates the contract. `messages` are short, human-readable, and never contain payload data
    beyond the offending path."""

    def __init__(self, messages: list[str]):
        super().__init__("; ".join(messages[:3]))
        self.messages = messages


def utf16_len(text: str) -> int:
    """Length in UTF-16 code units, which is what Zod's string .min()/.max() count."""
    return len(text.encode("utf-16-le")) // 2


# ---------------------------------------------------------------------------
# Typed, validated problem
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Options:
    time_limit_seconds: int
    seed: int
    num_workers: int
    reproducible: bool
    deterministic_time_limit: float | None


@dataclass(frozen=True)
class Assignment:
    id: str
    section_id: str
    subject_id: str
    requirement_id: str
    teacher_id: str
    periods: int


@dataclass(frozen=True)
class Problem:
    request_id: str
    options: Options
    weights: dict[str, int]
    day_names: tuple[str, ...]
    #: continues[k] (0-based period k) is True when period k+1 follows with no break; the last entry is always False
    continues: tuple[bool, ...]
    max_teacher_periods: int
    #: sorted by id so the model never depends on the input order
    sections: tuple[str, ...]
    teachers: tuple[tuple[str, int], ...]
    assignments: tuple[Assignment, ...]
    #: (assignment index, day index, period index 0-based), sorted
    fixed: tuple[tuple[int, int, int], ...]

    @property
    def days(self) -> int:
        return len(self.day_names)

    @property
    def periods_per_day(self) -> int:
        return len(self.continues)

    @property
    def weekly_slots(self) -> int:
        return self.days * self.periods_per_day


# ---------------------------------------------------------------------------
# Low-level checks
# ---------------------------------------------------------------------------
def is_int(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) <= MAX_SAFE_INTEGER
    return isinstance(value, float) and math.isfinite(value) and value.is_integer() and abs(value) <= MAX_SAFE_INTEGER


def is_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


class _Checker:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.truncated = False

    def err(self, path: str, message: str) -> None:
        if len(self.errors) >= MAX_REPORTED_ERRORS:
            self.truncated = True
            return
        self.errors.append(f"{path}: {message}"[:MAX_MESSAGE_LENGTH])

    def obj(self, value: Any, path: str, keys: tuple[str, ...]) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            self.err(path, "must be an object")
            return None
        missing = [k for k in keys if k not in value]
        extra = sorted(k for k in value if k not in keys)
        for key in missing:
            self.err(f"{path}.{key}", "is required")
        for key in extra[:5]:
            self.err(f"{path}.{key}", "unknown field")
        return None if missing or extra else value

    def int_in(self, value: Any, path: str, low: int, high: int) -> int | None:
        if not is_int(value):
            self.err(path, "must be an integer")
            return None
        number = int(value)
        if number < low or number > high:
            self.err(path, f"must be between {low} and {high}")
            return None
        return number

    def text(self, value: Any, path: str, low: int = 1, high: int = MAX_ID_LENGTH) -> str | None:
        if not isinstance(value, str):
            self.err(path, "must be a string")
            return None
        length = utf16_len(value)
        if length < low or length > high:
            self.err(path, f"length must be between {low} and {high}")
            return None
        return value

    def boolean(self, value: Any, path: str) -> bool | None:
        if not isinstance(value, bool):
            self.err(path, "must be a boolean")
            return None
        return value

    def array(self, value: Any, path: str, low: int, high: int) -> list[Any] | None:
        if not isinstance(value, list):
            self.err(path, "must be an array")
            return None
        if len(value) < low or len(value) > high:
            self.err(path, f"must contain between {low} and {high} items")
            return None
        return value


def extract_request_id(raw: Any) -> str | None:
    """The request id of a payload, if it is usable. Needed to answer a rejected input with a contract output."""
    if isinstance(raw, dict):
        value = raw.get("requestId")
        if isinstance(value, str) and 1 <= utf16_len(value) <= MAX_ID_LENGTH:
            return value
    return None


# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------
_TOP_KEYS = ("contractVersion", "requestId", "options", "weightsVersion", "weights", "grid", "sections", "teachers", "assignments", "fixedEntries")


def parse_problem(raw: Any) -> Problem:
    """Validate a decoded JSON payload and return the typed problem. Raises ContractError."""
    c = _Checker()
    top = c.obj(raw, "$", _TOP_KEYS)
    if top is None:
        raise ContractError(c.errors)

    if top["contractVersion"] != CONTRACT_VERSION:
        c.err("$.contractVersion", f"must be {CONTRACT_VERSION!r}")
    request_id = c.text(top["requestId"], "$.requestId")

    # ---- options -----------------------------------------------------------
    options: Options | None = None
    opt = c.obj(top["options"], "$.options", ("timeLimitSeconds", "seed", "numWorkers", "reproducible", "deterministicTimeLimit"))
    if opt is not None:
        time_limit = c.int_in(opt["timeLimitSeconds"], "$.options.timeLimitSeconds", 1, MAX_TIME_LIMIT_CEILING)
        seed = c.int_in(opt["seed"], "$.options.seed", 0, 2_147_483_647)
        workers = c.int_in(opt["numWorkers"], "$.options.numWorkers", 1, MAX_WORKERS)
        reproducible = c.boolean(opt["reproducible"], "$.options.reproducible")
        det = opt["deterministicTimeLimit"]
        det_value: float | None = None
        det_ok = True
        if det is not None:
            if not is_number(det) or det <= 0 or det > MAX_TIME_LIMIT_CEILING:
                c.err("$.options.deterministicTimeLimit", f"must be null or a number in (0, {MAX_TIME_LIMIT_CEILING}]")
                det_ok = False
            else:
                det_value = float(det)
        if det_ok and reproducible is not None:
            if reproducible and det_value is None:
                c.err("$.options.deterministicTimeLimit", "is required when reproducible is true")
            elif not reproducible and det_value is not None:
                c.err("$.options.deterministicTimeLimit", "must be null when reproducible is false")
        if None not in (time_limit, seed, workers, reproducible) and det_ok:
            options = Options(time_limit, seed, workers, reproducible, det_value)  # type: ignore[arg-type]

    # ---- weights -----------------------------------------------------------
    c.text(top["weightsVersion"], "$.weightsVersion", 1, 20)
    weights: dict[str, int] = {}
    w = c.obj(top["weights"], "$.weights", TERM_NAMES)
    if w is not None:
        for name in TERM_NAMES:
            value = c.int_in(w[name], f"$.weights.{name}", 0, 1_000)
            if value is not None:
                weights[name] = value

    # ---- grid --------------------------------------------------------------
    day_names: list[str] = []
    continues: list[bool] = []
    max_teacher = MAX_TEACHER_PERIODS_PER_WEEK
    grid = c.obj(top["grid"], "$.grid", ("days", "periods", "maxTeacherPeriodsPerWeek"))
    if grid is not None:
        days = c.array(grid["days"], "$.grid.days", 1, 7)
        if days is not None:
            for position, item in enumerate(days):
                d = c.obj(item, f"$.grid.days[{position}]", ("index", "dayOfWeek"))
                if d is None:
                    continue
                index = c.int_in(d["index"], f"$.grid.days[{position}].index", 0, 6)
                name = d["dayOfWeek"]
                if name not in DAYS_OF_WEEK:
                    c.err(f"$.grid.days[{position}].dayOfWeek", "is not a day of the week")
                    continue
                if index is not None and index != position:
                    c.err(f"$.grid.days[{position}].index", f"must equal its position {position}")
                if name in day_names:
                    c.err(f"$.grid.days[{position}].dayOfWeek", "duplicate working day")
                day_names.append(name)
        periods = c.array(grid["periods"], "$.grid.periods", 1, 12)
        if periods is not None:
            for position, item in enumerate(periods):
                p = c.obj(item, f"$.grid.periods[{position}]", ("periodNumber", "continuesIntoNext"))
                if p is None:
                    continue
                number = c.int_in(p["periodNumber"], f"$.grid.periods[{position}].periodNumber", 1, 12)
                flag = c.boolean(p["continuesIntoNext"], f"$.grid.periods[{position}].continuesIntoNext")
                if number is not None and number != position + 1:
                    c.err(f"$.grid.periods[{position}].periodNumber", f"must be {position + 1} (periods are numbered 1..K in order)")
                continues.append(bool(flag))
        mx = c.int_in(grid["maxTeacherPeriodsPerWeek"], "$.grid.maxTeacherPeriodsPerWeek", 1, MAX_TEACHER_PERIODS_PER_WEEK)
        if mx is not None:
            max_teacher = mx
    if continues:
        continues[-1] = False  # the last period has no successor, whatever the flag says

    # ---- sections / teachers -----------------------------------------------
    section_ids: list[str] = []
    for position, item in enumerate(c.array(top["sections"], "$.sections", 1, MAX_SECTIONS) or []):
        s = c.obj(item, f"$.sections[{position}]", ("id",))
        if s is not None:
            sid = c.text(s["id"], f"$.sections[{position}].id")
            if sid is not None:
                section_ids.append(sid)
    teachers: dict[str, int] = {}
    teacher_order: list[str] = []
    for position, item in enumerate(c.array(top["teachers"], "$.teachers", 1, MAX_TEACHERS) or []):
        t = c.obj(item, f"$.teachers[{position}]", ("id", "weeklyCapacity"))
        if t is not None:
            tid = c.text(t["id"], f"$.teachers[{position}].id")
            cap = c.int_in(t["weeklyCapacity"], f"$.teachers[{position}].weeklyCapacity", 1, MAX_TEACHER_PERIODS_PER_WEEK)
            if tid is not None and cap is not None:
                if tid in teachers:
                    c.err(f"$.teachers[{position}].id", "duplicate teacher id")
                teachers[tid] = cap
                teacher_order.append(tid)
    if len(set(section_ids)) != len(section_ids):
        c.err("$.sections", "duplicate section id")

    # ---- assignments -------------------------------------------------------
    assignments: list[Assignment] = []
    known_sections = set(section_ids)
    seen_ids: set[str] = set()
    seen_pairs: set[tuple[str, str]] = set()
    for position, item in enumerate(c.array(top["assignments"], "$.assignments", 1, MAX_ASSIGNMENTS) or []):
        path = f"$.assignments[{position}]"
        a = c.obj(item, path, ("id", "sectionId", "subjectId", "subjectRequirementId", "teacherId", "periodsPerWeek"))
        if a is None:
            continue
        values = [c.text(a[key], f"{path}.{key}") for key in ("id", "sectionId", "subjectId", "subjectRequirementId", "teacherId")]
        periods_value = c.int_in(a["periodsPerWeek"], f"{path}.periodsPerWeek", 1, 100)
        if None in values or periods_value is None:
            continue
        aid, sid, subj, req, tid = values  # type: ignore[misc]
        ok = True
        if aid in seen_ids:
            c.err(f"{path}.id", "duplicate assignment id")
            ok = False
        if sid not in known_sections:
            c.err(f"{path}.sectionId", "refers to an unknown section")
            ok = False
        if tid not in teachers:
            c.err(f"{path}.teacherId", "refers to an unknown teacher")
            ok = False
        if (sid, req) in seen_pairs:
            c.err(path, "a section and requirement may have only one assignment")
            ok = False
        seen_ids.add(aid)
        seen_pairs.add((sid, req))
        if ok:
            assignments.append(Assignment(aid, sid, subj, req, tid, periods_value))

    # ---- fixed entries (reserved for locked periods; always empty in V1) ------
    raw_fixed = c.array(top["fixedEntries"], "$.fixedEntries", 0, MAX_ENTRIES) or []
    assignment_index = {a.id: i for i, a in enumerate(sorted(assignments, key=lambda a: a.id))}
    day_index = {name: i for i, name in enumerate(day_names)}
    fixed: set[tuple[int, int, int]] = set()
    for position, item in enumerate(raw_fixed):
        path = f"$.fixedEntries[{position}]"
        f = c.obj(item, path, ("assignmentId", "dayOfWeek", "periodNumber"))
        if f is None:
            continue
        aid = c.text(f["assignmentId"], f"{path}.assignmentId")
        number = c.int_in(f["periodNumber"], f"{path}.periodNumber", 1, 12)
        name = f["dayOfWeek"]
        if name not in DAYS_OF_WEEK:
            c.err(f"{path}.dayOfWeek", "is not a day of the week")
            continue
        if aid is None or number is None:
            continue
        if aid not in assignment_index:
            c.err(f"{path}.assignmentId", "refers to an unknown assignment")
        elif name not in day_index:
            c.err(f"{path}.dayOfWeek", "is not a working day of this grid")
        elif number > len(continues):
            c.err(f"{path}.periodNumber", "is outside the grid")
        else:
            key = (assignment_index[aid], day_index[name], number - 1)
            if key in fixed:
                c.err(path, "duplicate fixed entry")
            fixed.add(key)

    if c.errors or request_id is None or options is None or len(weights) != len(TERM_NAMES):
        messages = list(c.errors)
        if c.truncated:
            messages.append("(more errors omitted)")
        raise ContractError(messages or ["invalid input"])

    return Problem(
        request_id=request_id,
        options=options,
        weights=weights,
        day_names=tuple(day_names),
        continues=tuple(continues),
        max_teacher_periods=max_teacher,
        sections=tuple(sorted(section_ids)),
        teachers=tuple(sorted(teachers.items())),
        assignments=tuple(sorted(assignments, key=lambda a: a.id)),
        fixed=tuple(sorted(fixed)),
    )


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
_ENTRY_KEYS = ("assignmentId", "sectionId", "subjectId", "teacherId", "dayOfWeek", "periodNumber")
_DIAGNOSTIC_KEYS = (
    "objectiveValue", "bestObjectiveBound", "wallSeconds", "numWorkers", "seed", "ortoolsVersion",
    "numBooleans", "numConstraints", "conflicts", "branches", "stoppedBy", "messages",
)


def validate_output(out: Any) -> None:
    """Strict mirror of solverOutputSchema. The CLI calls this before printing, so the process can never emit a
    payload the backend would have to reject. Raises ContractError."""
    c = _Checker()
    top = c.obj(out, "$", ("contractVersion", "requestId", "status", "entries", "diagnostics"))
    if top is None:
        raise ContractError(c.errors)
    if top["contractVersion"] != CONTRACT_VERSION:
        c.err("$.contractVersion", f"must be {CONTRACT_VERSION!r}")
    c.text(top["requestId"], "$.requestId")
    status = top["status"]
    if status not in SOLVER_STATUSES:
        c.err("$.status", "is not a solver status")
    entries = c.array(top["entries"], "$.entries", 0, MAX_ENTRIES)
    for position, item in enumerate(entries or []):
        path = f"$.entries[{position}]"
        e = c.obj(item, path, _ENTRY_KEYS)
        if e is None:
            continue
        for key in ("assignmentId", "sectionId", "subjectId", "teacherId"):
            c.text(e[key], f"{path}.{key}")
        if e["dayOfWeek"] not in DAYS_OF_WEEK:
            c.err(f"{path}.dayOfWeek", "is not a day of the week")
        if not is_int(e["periodNumber"]):
            c.err(f"{path}.periodNumber", "must be an integer")
    if status in ("INFEASIBLE", "UNKNOWN", "MODEL_INVALID", "INPUT_INVALID") and entries:
        c.err("$.entries", f"must be empty for status {status}")
    if status in ("OPTIMAL", "FEASIBLE") and entries is not None and not entries:
        c.err("$.entries", f"must not be empty for status {status}")

    d = c.obj(top["diagnostics"], "$.diagnostics", _DIAGNOSTIC_KEYS)
    if d is not None:
        for key in ("objectiveValue", "bestObjectiveBound"):
            if d[key] is not None and not is_number(d[key]):
                c.err(f"$.diagnostics.{key}", "must be null or a finite number")
        if not is_number(d["wallSeconds"]) or d["wallSeconds"] < 0:
            c.err("$.diagnostics.wallSeconds", "must be a number >= 0")
        for key in ("numWorkers",):
            if not is_int(d[key]) or d[key] < 0:
                c.err(f"$.diagnostics.{key}", "must be an integer >= 0")
        if not is_int(d["seed"]):
            c.err("$.diagnostics.seed", "must be an integer")
        c.text(d["ortoolsVersion"], "$.diagnostics.ortoolsVersion", 0, 50)
        for key in ("numBooleans", "numConstraints", "conflicts", "branches"):
            if d[key] is not None and (not is_int(d[key]) or d[key] < 0):
                c.err(f"$.diagnostics.{key}", "must be null or an integer >= 0")
        if d["stoppedBy"] not in STOPPED_BY:
            c.err("$.diagnostics.stoppedBy", "is not a valid stop reason")
        messages = c.array(d["messages"], "$.diagnostics.messages", 0, MAX_MESSAGES)
        for position, message in enumerate(messages or []):
            c.text(message, f"$.diagnostics.messages[{position}]", 0, MAX_MESSAGE_LENGTH)
    if c.errors:
        raise ContractError(c.errors)
