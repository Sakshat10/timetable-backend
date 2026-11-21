# Module 9 — Schedule Configuration (simplified model)

The **schedule configuration** is the school's standard weekly schedule for an academic year. The school configures **only**:

1. the **working days** (any subset of Monday–Sunday),
2. the number of **teaching periods per day** (`periodsPerDay`, 2–12),
3. **exactly one break per day**, given as the period it comes **after** (`breakAfterPeriod`, `1 … periodsPerDay − 1`).

There are **no clock times**: no period start/end, no break start/end or duration, no lunch/assembly/other events. Timetables are generated from
period numbers and the break position only. The break is **not a teaching period**: it never counts toward subject requirements, teacher workload or
weekly capacity.

> Weekly teaching capacity = working days × teaching periods per day. Example: Mon–Sat, 6 periods, break after 4 → `6 × 6 = 36`
> (periods 1-4, break, periods 5-6).

There is exactly **one configuration per academic year**, shared by every grade. It is *not* a calendar: half-days, exams and holidays are a future module.

## Model
- `ScheduleConfig` — one per academic year (unique `academicYearId`): `periodsPerDay`, **`breakAfterPeriod`** (nullable, see Legacy), CHECK `1 ≤ breakAfterPeriod < periodsPerDay`.
- `ScheduleDay` — one row per working day.
- `SchedulePeriod`, `ScheduleTimingEvent` — **legacy, read-only history** (see below). Nothing writes them any more and no scheduling code reads their clock times.

## Endpoints
All require authentication; the school comes from the session.

| Method | Path | Body |
|---|---|---|
| POST | /api/schedule-configs | `{ academicYearId, workingDays, periodsPerDay, breakAfterPeriod }` |
| GET | /api/schedule-configs[?academicYearId=] | list |
| GET | /api/schedule-configs/:id | one |
| PATCH | /api/schedule-configs/:id | any of `workingDays`, `periodsPerDay`, `breakAfterPeriod` |

Response:
```json
{ "id": "…", "academicYearId": "…", "periodsPerDay": 6, "workingDays": ["MONDAY", "…"], "breakAfterPeriod": 4,
  "weeklyTeachingCapacity": 36, "legacy": false,
  "periods": [{ "periodNumber": 1, "startTime": null, "endTime": null }, "…"],
  "timingEvents": [],
  "timeline": [{ "kind": "PERIOD", "periodNumber": 1, "startTime": null, "endTime": null }, "…", { "kind": "BREAK", "afterPeriodNumber": 4 }, "…"],
  "createdAt": "…", "updatedAt": "…" }
```
`periods`, `timingEvents` and `timeline` are kept so existing clients still parse; the times are `null`/empty for a simplified configuration.

## Rules
- Working days: 1–7 distinct days. `periodsPerDay`: strict integer 2–12 (a break needs a period on each side). `breakAfterPeriod`: strict integer `1 … periodsPerDay − 1` — never after the last period.
- `periods` and `timingEvents` in a request are refused with 400 (`Clock times are no longer part of the schedule…`).
- PATCH merges the supplied fields into the current state under a row lock and validates the **whole** result (lowering `periodsPerDay` below the break is a 400: send `breakAfterPeriod` too).
- Create and PATCH only while the academic year is **DRAFT**. Strict types (no coercion).
- Concurrency: unique index → one 201 + one 409 on simultaneous creates; PATCHes serialize (`FOR UPDATE` on the config, `FOR SHARE` on the year).

## Legacy configurations (made before migration `20261117090000`)
- Migration backfill: a configuration with **exactly one** timing event positioned after a teaching period gets that position as `breakAfterPeriod` (behaviour-preserving: the scheduler already ended a consecutive run at any event).
- Configurations with zero events, several events, or an event before period 1 / after the last period are **ambiguous** for a one-break model. They stay `breakAfterPeriod = null`, `legacy: true`, keep generating from their stored event positions, and are returned with their stored times unchanged (read-only history).
- To convert one: `PATCH { breakAfterPeriod }` (nothing is guessed). The legacy rows are **not** deleted.

## What the engine reads
`src/modules/schedule-config/schedule-config.effective.ts` (`effectiveSchedule`) is the single place that turns a stored configuration into working days, periods `1..n`, break positions and capacity. The generator input (`continuesIntoNext` = period `k` is followed by `k+1` without the break), feasibility, the generation snapshot / input hash, staleness, publish checks and the substitution consecutive-period logic all use it. No clock time is read.

## Timetable versions
New runs store an **empty** period-time list (`[]`, with a capture timestamp) = "no clock times by design"; the view API reports `periodTimes.source: "NONE"`. Versions generated earlier keep their stored snapshot (`SNAPSHOT`) or none (`UNAVAILABLE`) exactly as before; nothing is rewritten.

## Errors
400 validation / not DRAFT / empty or inconsistent PATCH · 401 · 403 other school · 404 unknown · 409 a configuration already exists.
