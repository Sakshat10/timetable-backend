# Timetable solver (Module 11, Phase 2)

The production CP-SAT solver. It is a small, isolated Python process: it reads one JSON request on stdin, solves,
and writes one JSON document on stdout. It has **no database, no Prisma, no network and no knowledge of the Node
application**; it never persists anything and never decides what a failure means.

**The TypeScript contract is the source of truth** (`src/modules/timetable-generation/timetable-generation.contracts.ts`
and `…metrics.ts`). `tests/test_contract_sync.py` fails if the constants here drift from it.

## Setup (pinned)

```bash
cd solver
python3 -m venv .venv                      # Python 3.14.7 (see .python-version)
.venv/bin/pip install -r requirements.txt  # ortools==9.15.6755 (the only direct dependency)
```

Verified on Python 3.14.7 / OR-Tools 9.15.6755 / Apple M2 (arm64, macOS). Other combinations are untested.

## Running

```bash
.venv/bin/python main.py < request.json > response.json
```

### Protocol

* **Request**: one JSON document. The solver starts as soon as the document is complete and does **not** wait for
  end-of-file (`timetable_solver/request_reader.py`). This is deliberate: under Node's `child_process` the child's stdio
  is a socket pair and the end-of-input signal is not reliably delivered (a trivial script that read stdin to EOF hung in
  about 1 of 40 runs under `spawnSync`, measured in Phase 2). Callers should send compact JSON; a trailing newline or
  pretty-printing is fine. Maximum 32 MB.
* **Response**: exactly one JSON document on stdout, validated against the output contract before it is printed.
  stderr carries one summary line (and a traceback on internal errors). Nothing else is ever printed on stdout.
* **Exit codes**

  | Code | Meaning | stdout |
  |---|---|---|
  | 0 | A response was printed. Its `status` carries the result, including `INFEASIBLE`, `UNKNOWN` and `INPUT_INVALID`. | one document |
  | 2 | The input could not be answered with a contract document (not JSON, oversize, no usable `requestId`). | empty |
  | 3 | Internal error, or the produced document violated the contract. | empty |
  | 4 | The parent process died (watchdog). | empty |

  A process that cannot produce a verified document exits non-zero. It **never** turns a failure into a result.

### Statuses (what CP-SAT said, nothing more)

| `status` | Meaning | `entries` | `stoppedBy` |
|---|---|---|---|
| `OPTIMAL` | Proven best for the objective. Realistic mainly for small schools. | complete timetable | `OPTIMAL` |
| `FEASIBLE` | A valid timetable, not proven optimal. **The normal result for medium and large schools.** | complete timetable | `TIME_LIMIT` / `DETERMINISTIC_LIMIT` / `LIMIT_AMBIGUOUS` |
| `UNKNOWN` | CP-SAT found no solution within the budget (or the budget was spent before the solve could start). | empty | `TIME_LIMIT` / `DETERMINISTIC_LIMIT` / `LIMIT_AMBIGUOUS` |
| `INFEASIBLE` | No timetable exists. Either an exact capacity certificate (a teacher or section above its limit, decided before CP-SAT runs, named in `messages`) or CP-SAT proved it (e.g. contradictory `fixedEntries`). | empty | `INFEASIBLE` |
| `MODEL_INVALID` | CP-SAT rejected the model. A bug, never expected. | empty | `ERROR` |
| `INPUT_INVALID` | The payload violated the contract; `messages` list the first offending paths. | empty | `ERROR` |

`stoppedBy` says which limit ended a search that was cut short. CP-SAT does not report that itself, so it is inferred from how close each limit was: only the deterministic limit reached = `DETERMINISTIC_LIMIT` (the only stop a reproducible run can promise to repeat), only the wall clock = `TIME_LIMIT`, **both = `LIMIT_AMBIGUOUS`** (the cause cannot be established, so repeatability is not claimed).

There is **no baseline and no fallback here.** The constructive baseline and the "UNKNOWN becomes a baseline result"
rule live in the Node orchestration layer (decisions B and D4).

`diagnostics.objectiveValue` / `bestObjectiveBound` are **diagnostic only**. The soft variables are bounded from below
only, so an unconverged solution can carry slack (measured: up to 1,586 points in Phase 0); the backend recomputes every
metric from the entries with its own evaluator, which is authoritative.

## Time budget

`options.timeLimitSeconds` is the budget of the **whole process**. The clock starts before OR-Tools is imported, so
interpreter start-up, validation and model construction are charged against it. CP-SAT gets
`timeLimitSeconds - elapsed - 0.25 s`; if less than 0.05 s remains the answer is `UNKNOWN` without solving.
The solver deliberately has no self-imposed hard deadline: the kill deadline belongs to the backend, and a solver that
exited non-zero by itself would be indistinguishable from a crash.

## Workers and resources

The number of CP-SAT workers is exactly `options.numWorkers`; the process starts no other workers, threads (apart from
the watchdog) or processes. Worker and concurrency policy belongs to the Node runner. Phase 0 measured roughly
550-700 MB peak memory for a 100-section school at 4 workers.

## Reproducible mode (opt-in, not the production default)

`options.reproducible = true` enables CP-SAT `interleave_search` (documented as experimental) with
`max_deterministic_time = options.deterministicTimeLimit`; the wall-clock limit stays as a backstop. Intended for audit,
debugging and reproduction. It is slower and may produce worse solutions within the same wall-clock budget.

What has been verified, and nothing more: on one machine with OR-Tools 9.15.6755, the same input gave identical entries
across repeated runs (also when the input arrays were shuffled). **No cross-machine or cross-version guarantee is made.**
Measured limitations: with several workers the `seed` had no effect on the result in this mode (seeds 1-4 gave one
timetable); with one worker different seeds gave different results, and a small deterministic budget can end `UNKNOWN`.
`reproducible` requires `deterministicTimeLimit` to be set, and `deterministicTimeLimit` must be `null` otherwise
(stricter than the Zod schema, which allows both; the Node side must build consistent options).

## The model

One Boolean `x[assignment][slot]` per assignment and weekly slot. The teacher of each assignment is fixed by the
backend, so there is no teacher dimension. **No solution hint is ever added.**

Hard: exact weekly periods per assignment; at most one lesson per section per slot; at most one per teacher per slot;
locked `fixedEntries` (reserved, empty in V1). The constant checks (teacher load within `min(weeklyCapacity, W,
maxTeacherPeriodsPerWeek)`, section demand within `W`) are decided before the model is built and yield an exact
`INFEASIBLE` certificate.

Soft terms are the canonical definitions of `timetable-generation.metrics.ts`, implemented without reinterpretation:
`teacherRun3`, `teacherRun4Plus`, `subjectSameDayExcess`, `sectionHoles`, `dailyLoadExcess`, weighted by the
`weights` of the request (WEIGHTS_V1 as sent by Node). Teachers with weekly load below 3 take part in no teacher term;
sections whose demand equals the weekly slots take part in no section term. The school's single break
(`continuesIntoNext = false` after the break position, and after the last period) ends a consecutive run.

## Validation

Every object is strict (all fields required, unknown fields rejected, like `z.strictObject`); an integral float counts as
an integer (JSON has no int/float distinction in JavaScript); ids are measured in UTF-16 units like Zod. Beyond the
schema: unique ids, assignments that reference known sections and teachers, one assignment per (section, requirement),
a grid whose day indexes and period numbers are consistent, and well-formed `fixedEntries`. The solver cannot see
grades or streams (a `streamId`/`gradeId` field is rejected): stream matching is the Node normalizer's job.

## Tests

```bash
cd solver && .venv/bin/python -m unittest discover -s tests -t .       # Python suite (stdlib unittest)
cd .. && npx tsx test-solver-contract.ts                                # TypeScript <-> Python conformance (real Zod, real CLI)
```

Objective agreement is tested by locking every lesson in place with `fixedEntries`, which leaves only the soft
variables free: the optimum is then exactly the canonical objective of those entries, compared with hand-computed
values, an independent evaluator (`tests/canonical.py`) and the TypeScript golden fixtures
(`test-fixtures/timetable-generation/golden-metrics.json`).

## Notes for Phase 3 (the Node SolverClient)

* Send the request as compact JSON; do not rely on closing stdin to start the solver.
* Spawn without a shell, with a minimal environment (the solver needs none of the application's variables).
* Kill at `budget + grace`; a killed process is a watchdog fallback, any other abnormal end is a process fault.
* Map exit code 0 to "parse stdout", anything else to a process fault; never retry a fault silently.
* The watchdog detects a dead parent by a changed parent pid, recorded at the first line of `main.py`. If the parent
  dies before that line the orphan cannot be recognised; it still ends by its own time budget.
