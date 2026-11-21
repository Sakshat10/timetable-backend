# Record management: safe deletion, deactivation and correction

The schema cascades almost everywhere (a deleted section would delete its timetable lessons; a deleted teacher their assignments and cover history). So deletion is never left to the cascade:
each `DELETE` below checks every dependency first, inside a transaction, and answers **409** with `errors.blockedBy` naming what is in the way. History is retired, not erased.

## Audit: what each entity can do

| Entity | Create | Edit | Delete (this module) | Retire |
|---|---|---|---|---|
| Academic year | POST | PATCH name/dates/status (lifecycle DRAFT→ACTIVE→COMPLETED, unchanged) | **DELETE** only if DRAFT and empty (no grades, versions or generation runs); its schedule config goes with it | the lifecycle itself (COMPLETED) |
| Grade | POST, bulk | PATCH name/order (DRAFT) | **DELETE** DRAFT; blocked by sections, streams, requirements, teacher grade eligibility | – |
| Stream | POST | PATCH name/code (DRAFT) | **DELETE** DRAFT; blocked by sections, requirements | – |
| Section | POST | PATCH name/code (DRAFT) | **DELETE** DRAFT; blocked by assignments, selected-sections requirement scopes, cover requests, timetable lessons of any version | – |
| Subject | POST, bulk | PATCH name/code | **DELETE**; blocked by requirements (any year), teacher links, cover requests, lessons | – |
| Curriculum requirement | POST, `PUT /curriculum/grades/:id`, copy | PATCH periods/optional/section scope (DRAFT) | existing `DELETE /subject-requirements/:id` (409 while assigned) | – |
| Teacher | POST, bulk | PATCH name/code | **DELETE** only with no assignments, lessons, covers, absences, unavailability (their subject links go with them) | **PATCH `isActive:false/true`** (deactivate / reactivate) |
| Teacher-subject link / grade eligibility | POST | PATCH type/gradeScope | existing `DELETE /teacher-subjects/:id`, `DELETE …/grades/:gradeId` (409 while an assignment depends) | – |
| Section assignment | POST | PATCH | existing `DELETE` | – |
| Schedule configuration | POST | PATCH (DRAFT) | **DELETE** (reset) DRAFT; blocked by any timetable version of the year or a queued/running generation | – |
| Absence / unavailability / substitution | POST | PATCH, assign, reassign | cancel / unassign / `DELETE /teacher-unavailability/:id` (existing). Cover requests and events are never deleted | cancelled status |
| Timetable version | generate / clone | moves, locks | existing `DELETE` (drafts only) | PUBLISHED → ARCHIVED on republish |

## Rules
- Auth and school isolation: 401 / 403 (another school) / 404 / 400 (bad id, or the academic year is not DRAFT for year-scoped structure).
- A record's dependents are counted **after** it is locked `FOR UPDATE` (year `FOR SHARE` → grade → record, the same direction as every writer), so a concurrent assignment/lesson/requirement either blocks the delete or loses cleanly (409).
- Lessons in **any** version (draft, published, archived) protect their section, subject and teacher. To remove a section that was ever generated, delete the draft versions first; published history keeps it.
- To stop a teacher getting new work without losing history: `PATCH /api/teachers/:id { "isActive": false }`. Inactive teachers cannot receive new assignments, are not auto-allocated, and a generation that would use one is refused; reactivate the same way.
- Curriculum edits and requirement deletes make existing drafts stale (existing configuration comparison); published timetables are never modified.

## Database backstop (migration `20261025090000_protect_history_from_cascade`)
`timetable_entries` (section, subject, teacher), `cover_requests` (section, subject, both teachers), `teacher_absences` and `teacher_unavailabilities` (teacher) change from `ON DELETE CASCADE` to `NO ACTION DEFERRABLE INITIALLY DEFERRED`:
a direct delete of a section/subject/teacher that still has history now fails at commit, while deleting a whole school or a timetable version still cascades as before. No data is changed. Deploy: `prisma migrate deploy`.
Rollback: recreate the nine constraints with `ON DELETE CASCADE` (list in the migration).

`P2003` (a foreign key lost a race with a delete) is answered 409 "reload and try again" instead of 500.

## Not done (decisions in the report)
Name/date edits of an ACTIVE or COMPLETED academic year are still allowed by the existing PATCH; archived/retired flags for grades, subjects or sections do not exist (deletion is blocked instead).
