# Substitution (teacher absence → lessons needing cover → replacement)

Backend only. Every route is under `/api`, needs an authenticated admin, and is scoped to that admin's school (another school's record is 403, an unknown one 404).

## Source of lessons
Always the school's **PUBLISHED** timetable version. Drafts and archived versions are never used. A date maps to the academic year (DRAFT or ACTIVE, never COMPLETED)
whose date range contains it and whose published version supplies the lessons; no such year/version means no cover is needed for that date (the absence is still recorded
and the response says how many dates had no timetable). Dates are calendar dates (`YYYY-MM-DD`, no time zone: the schema stores none); "today" is the UTC date.

## Routes
| Route | Purpose |
|---|---|
| `POST /teacher-absences` | Record an absence (FULL_DAY, or PERIODS `fromPeriod`..`toPeriod` on each day), max 366 days. Creates the cover requests **and assigns substitutes automatically** (see *Automatic substitution*); body flags `autoAssign` (default true) and `allowTemporaryCover` (default true) |
| `GET /teacher-absences`, `GET /teacher-absences/:id` | List (filters `teacherId`, `status`, `from`, `to`) / read, with cover counts per status |
| `PATCH /teacher-absences/:id` | Change dates, periods, reason of an ACTIVE absence; new/reopened lessons are assigned automatically (same flags) |
| `POST /teacher-absences/:id/auto-assign` | Run or **retry** the automatic allocation of an absence (idempotent). Body `{ allowTemporaryCover? }` |
| `GET /teacher-absences/:id/substitution-summary` | Read-only result: affected lessons, assigned (automatic/manual), unfilled with reason, temporary covers, every request id and status |
| `POST /substitutions/auto-assign` | Allocate every OPEN request of the school in `{ from?, to? }` (e.g. after a republish). Idempotent |
| `GET /substitution-events` | Persistent school-scoped event feed for notifications (`since`, `limit`) |
| `POST /teacher-absences/:id/cancel` | Soft cancel |
| `POST /teacher-unavailability`, `GET /teacher-unavailability`, `DELETE /teacher-unavailability/:id` | Mark a teacher unavailable for cover on a date (whole day or one period); list; soft remove |
| `GET /substitutions` | Lessons needing cover and the history (all statuses; filters `status`, `from`, `to`, `absentTeacherId`, `replacementTeacherId`, `absenceId`, `limit`, `offset`) |
| `GET /substitutions/:id` | One request with its complete audit trail (`history`) |
| `GET /substitutions/:id/candidates` | Valid replacements, or a clear reason when there are none (`includeExcluded=true`: every other teacher with the reason) |
| `PUT /substitutions/:id/assignment` | Assign (OPEN) or reassign (ASSIGNED) a replacement |
| `DELETE /substitutions/:id/assignment` | ASSIGNED → OPEN |
| `POST /substitutions/:id/cancel` | OPEN/ASSIGNED → CANCELLED (no cover needed), optional `{ reason }` |

## Automatic substitution
Recording (or editing) an absence now also **assigns the best available substitute to every affected lesson**; the admin only records the absence. Everything reuses the existing lifecycle:
the same cover requests, the same hard constraints (`classifyCandidate`), the same tiers, the same locks and checks on assignment (re-run under locks before each write) and the same `cover_requests` /
`cover_events` rows. The published timetable is only read.

**Triggers**: a new absence (full or partial day, also when other absences exist that day); an edit of an absence (new or reopened lessons); `POST /teacher-absences/:id/auto-assign`;
`POST /substitutions/auto-assign` (range); and whenever an *automatic* substitute is recorded absent or marked unavailable (their lessons are released and allocated again). Never from a GET.
The absence is committed first; if the allocation fails the response is still `201` with `automaticAllocation.status = FAILED` and a retry hint, and the retry endpoint finishes the work.
Only OPEN requests with a date **today or later** are considered (a past date is reported as `PAST_DATE`); `autoAssign: false` records the absence and leaves everything OPEN.

**Algorithm** (`substitution.allocator.ts`, pure; one transaction per day, serialised per school): all OPEN lessons of the day are decided *together*. Repeatedly the lesson with the **fewest remaining
options** is decided first (ties: fewest *qualified* options, then period, section, id), its best candidate is **reserved immediately** (no double booking, no overlapping periods) and every other lesson
is re-evaluated. Hard constraints: same school, active, not the absent teacher, not absent, not unavailable, no lesson of the published timetable and no cover in that period. Ranking (one comparator, also used by
`GET /substitutions/:id/candidates`): tier (same subject > anyone free > four-in-a-row) → subject basis (primary link > secondary link > teaches it in the timetable) → **grade eligible** (ALL_GRADES or a grade row) →
**lower weekly workload** → fewer covers that day → shorter consecutive run → **fewer recent covers (28 days, fairness)** → name → id.
* **Four consecutive periods** is a school setting (`GET/PUT /api/substitution-settings`, column `schools.consecutivePeriodPolicy`, default and value for every existing school `PREFER_AVOID`):
  `ALLOW` (permitted, no warning), `PREFER_AVOID` (avoided while another teacher can take the lesson, used automatically as a **last resort**, flagged `lastResort` in the event and note; a *manual* assignment then needs
  `confirmFourConsecutive`), `NEVER_ALLOW` (never, automatically or manually: the lesson stays OPEN with `CONSECUTIVE_PERIODS_NOT_ALLOWED`, a manual attempt is `409 FOUR_CONSECUTIVE_NOT_ALLOWED`, candidates list the teacher as excluded with
  `CONSECUTIVE_NOT_ALLOWED`). The policy only judges the run a *cover* would join (normal lessons + covers that day, a break ends the run); it does not alter the timetable generator's constraints and is not a weekly workload limit. Changing it
  affects future decisions only.
* **Temporary unqualified cover**: if no teacher of the subject is free, any other free teacher may cover (the school's existing policy); the request is marked `temporaryUnqualified: true` and the event says so; no subject link or
  grade eligibility is created. `allowTemporaryCover: false` turns the fallback off (`NO_QUALIFIED_TEACHER`).
* Nobody free: the request stays OPEN with `attention` `{ code: NO_AVAILABLE_TEACHER | NO_QUALIFIED_TEACHER | ONLY_LAST_RESORT_CANDIDATES | PAST_DATE, message }` and one `AUTO_UNFILLED` event (not repeated on retries). Other lessons are still assigned.
* **Weekly workload**: the school configures *no* weekly maximum, so none is invented; workload = the teacher's lessons they will actually teach that Monday–Sunday week in the published version + covers assigned that week. It ranks, it never refuses.

After the greedy pass, a bounded **augmenting-path repair** looks, for every lesson still without a teacher, for a chain of swaps *within the same period among this run's own assignments* that frees a teacher
(greedy "fewest options first" alone missed a possible full cover in ~0.5% of random dense layouts; with the repair the number of lessons covered per period is the mathematical maximum in 5000 random layouts). Nothing already assigned by anyone
else moves, and every moved lesson is re-ranked. Known limits: the choice is still greedy across *different* periods (a teacher taken for P4 can turn a P5 cover into a last resort; the policy decides what happens then), fairness and workload are heuristics,
not a global optimum. No global optimiser is justified at this scale.

**Manual override**: only OPEN requests are ever touched; an assignment made by an admin (`assignmentSource: MANUAL`, also after reassigning an automatic one) is never overwritten by any run. Unassigning makes the request eligible again;
cancelled/obsolete requests are final. An *automatic* assignment gives way when its absence is cancelled or shrunk (cancelled, history kept) or its substitute becomes absent/unavailable (released and reallocated, event `AUTO_RELEASED`);
a *manual* one still blocks those changes with the same 409s as before.
**Why**: each `AUTO_ASSIGNED` event carries `details` (tier, subject basis, grade eligibility, workload, covers today, run, candidates considered, next best, exclusion counts, ranking order); `GET /substitutions/:id/candidates?includeExcluded=true`
shows the same facts (`gradeEligible`, `weeklyLoad`, `recentCovers`, `temporaryUnqualified`) and every excluded teacher with the reason.

**Concurrency**: an advisory lock per school serialises allocation runs; the allocator never *waits* for a lock a manual operation holds (cover row, teacher row, version row: `SKIP LOCKED`; per-teacher-date lock: try-lock), so it cannot deadlock
with them, and a busy lesson is retried (3 rounds) then left OPEN; the partial unique index on (replacement, date, period) is the last guard.

**Response** (`POST /teacher-absences`, `PATCH`, `POST …/auto-assign`): existing fields unchanged, plus `automaticAllocation: { enabled, status: COMPLETED|FAILED|DISABLED, totalAffectedLessons, assigned, automaticallyAssigned, manuallyAssigned,
unfilled, temporaryUnqualifiedCovers, skippedPastDates, needsAdminAttention, covers[{ id, date, periodNumber, status, section, subject, replacementTeacher, assignmentSource, temporaryUnqualified, attention }], run: { considered, assigned, unfilled, conflicts, skippedPast } }`.
**Events** (`GET /substitution-events`): `ABSENCE_RECORDED`, `ABSENCE_CANCELLED`, `SUBSTITUTE_AUTO_ASSIGNED`, `NO_SUBSTITUTE_AVAILABLE`, `ASSIGNMENT_CHANGED`, `SUBSTITUTE_REPLACED`, `ASSIGNMENT_CANCELLED`, `SUBSTITUTE_RELEASED`, derived from the append-only audit trail (no separate notification table).
**Publishing** (`POST /api/timetable-versions/:id/publish`): *after the publish transaction has committed* (never inside it, never from a GET) the controller calls `substitutionService.afterPublish`, which reconciles the cover requests (old version's future requests
→ OBSOLETE with history; new OPEN requests from the new version) and allocates only the requests of the new version. The publish response keeps its fields and gains `data.substitution` (`{ status: COMPLETED, run }` or `{ status: FAILED, error }`).
A failure cannot affect the publish; the requests stay OPEN and `POST /api/substitutions/auto-assign` recovers them (idempotent). Past dates are never allocated. A new request that replaces a lesson an **admin had assigned** is *not* auto-filled: it stays OPEN with
`attention MANUAL_ASSIGNMENT_NEEDS_REVIEW` (the old request keeps the admin's choice as OBSOLETE history). Assigning the very teacher the allocator chose is the admin *confirming* it: it becomes MANUAL. The per-request flag `autoAssign: false` applies to that
request only; requests created later by a republish are allocated like any other.
**Event feed** (`GET /api/substitution-events?limit&cursor|since`): ordered by (time, id); use `nextCursor` as `cursor` to continue exactly after the last event (events written by one transaction share a timestamp, so `nextSince` alone can skip some and is kept only for compatibility). Max `limit` 500.

## Policy: a substitution is a temporary cover, not a qualification
A substitute needs **no teacher-subject link and no grade-eligibility row**, and assigning one never creates or changes either (they are permanent teaching data; a cover is only a
`cover_requests` row for one lesson on one date). *(Earlier versions required both for every substitute; the school policy replaced that.)* Qualification is a **preference**, not a rule.

A teacher is a **candidate** when they are: in the same school, active, not the absent teacher, not absent and not marked unavailable in that period, with no lesson of the published
timetable in that period and no other cover assigned in it. Choosing the absent or an inactive teacher is **400**; every other conflict is **409** (`errors.code` names the rule).

## Candidate priority (three tiers)
`GET /substitutions/:id/candidates` returns every candidate ranked and labelled by tier. Nobody is chosen for the admin.

1. **SAME_SUBJECT**: a teacher of the lesson's subject whose cover would NOT give them four consecutive teaching periods. "Teacher of the subject" is read from existing data, so nobody has
   to add a link just to enable substitution: a teacher-subject link of either type (`PRIMARY_LINK`, `SECONDARY_LINK`; the grade scope and eligibility rows are irrelevant), or lessons of that
   subject in the published timetable (`TEACHES_IN_TIMETABLE`). Within the tier that order is also the ranking (primary link first).
2. **OTHER_AVAILABLE**: any other candidate, also without four in a row. No subject link, no grade eligibility.
3. **LAST_RESORT**: whoever would end with four or more consecutive periods. Offered (`offered: true`, `selection.lastResortOffered`) only when tiers 1 and 2 are empty; otherwise still returned
   but `offered: false`. Assigning one needs `confirmFourConsecutive: true`.

Within a tier: (tiers 1 and 3: how the subject is taught, as above), then the shorter resulting run, then fewer covers already assigned that day, then name, then id. If nobody is a
candidate the response has `candidates: []` and a `message` listing why ("N teachers are absent in this period; ..."), and the request stays unassigned.

**Consecutive periods** use the period order of the academic year's schedule: the school's single break (`breakAfterPeriod`; for a legacy configuration, its stored timing-event positions) after period k ends the run there (the generator's own rule).
A teacher's teaching that day is their lessons in the PUBLISHED version on that weekday that they will actually teach (a lesson inside their own absence is not theirs) plus the covers
already assigned to them that date. The run through the proposed period is measured before choosing; four or more is the threshold.

Each candidate carries `tier`, `tierKey`, `offered`, `recommended`, `requiresConfirmation`, `subjectBasis` (`PRIMARY_LINK`, `SECONDARY_LINK`, `TEACHES_IN_TIMETABLE` or null), `sameSubject`, `free`,
`coverLoadToday`, `consecutive { resultingRun, from, to, periods, createsFourConsecutive }` and an `explanation`; `selection` carries the summary sentence, counts per tier and `recommendedTeacherId`.

**At assignment the server recomputes everything under its locks.** A teacher who has become absent/unavailable/booked is refused as before. A teacher who would now end with four or more in a
row gets `409 FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED` (`errors.periods` lists them) unless `confirmFourConsecutive` is true; the warning alone never blocks. A confirmed last-resort assignment is
written to the history (`note`: "Last-resort assignment confirmed by the admin: N consecutive teaching periods (P5–P8)"). Cover records stay separate, date-specific rows: the published timetable is
never written.

## Lifecycle
`OPEN → ASSIGNED ⇄ (reassign) → …`, `ASSIGNED → OPEN` (unassign), `OPEN|ASSIGNED → CANCELLED`, and `OPEN|ASSIGNED → OBSOLETE` (system). CANCELLED and OBSOLETE are final.
Every transition writes an append-only `cover_events` row: action, from/to status, from/to teacher, the admin (null for system actions), note, time.

* **New timetable version published**: a request is a snapshot of one lesson of one version. When its version is no longer PUBLISHED, requests of upcoming dates become OBSOLETE (the
  replacement is released but stays on record) and a **new OPEN request** is created from the new version (`supersedesId` points to the old one). Assignments are never carried over
  silently. Past dates are left exactly as they were. This reconciliation is idempotent and runs (serialised per school) before cover requests are listed or changed; publishing
  itself is untouched. An assignment re-checks that the version is still PUBLISHED under a share lock, so it cannot race a publish.
* **Absence changes**: changing an absence cancels OPEN requests that fall outside it (reopened if a later change brings the lesson back) and creates requests for lessons that fall in;
  an ASSIGNED substitution that would fall outside blocks the change (409). Cancelling an absence is blocked while any substitution is ASSIGNED.
* A teacher who is the assigned replacement for a slot cannot be recorded absent/unavailable for it (409).
* Inactive teachers are not automatically absent. Duplicate cover is impossible: one request per absence/version/lesson/date, and at most one live request per lesson and date.

## Concurrency
Absence/unavailability changes lock the teacher row `FOR UPDATE`; assignment locks the request row, its version, the replacement teacher, link and eligibility rows (`FOR SHARE`), and
re-evaluates under those locks. Unique partial indexes are the last guard (one ASSIGNED request per replacement, date and period; one live request per lesson and date).

## Not covered / limitations
The admin's `autoAssign:false` is not remembered across a republish; an unassign makes a lesson eligible for automatic assignment again; the settings change is not audited (only `updatedAt`); no roles beyond "authenticated admin of the school"; no time zone (UTC dates); no push notifications (the event feed is polled); a cancelled lesson cover is recreated if a new timetable
version is published (the new lesson data is new); assigned substitutions are not carried across versions automatically.
