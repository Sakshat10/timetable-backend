"""Hard constraints (H1-H4), checked on real solves by the independent checker in tests/canonical.py."""
import itertools
import random
import unittest

from timetable_solver.contract import DAYS_OF_WEEK
from tests import canonical
from tests.helpers import all_continue, golden_cases, golden_input, make_input as _make_input, options, solve_input


NO_OBJECTIVE = {name: 0 for name in canonical.TERMS}


def make_input(*args, **kwargs):
    """These tests are about the HARD constraints, so the objective is switched off: the solve ends at the first
    feasible timetable instead of optimising until the time limit. (TestsWithTheFullObjective keeps real weights.)"""
    kwargs.setdefault("weights", NO_OBJECTIVE)
    return _make_input(*args, **kwargs)


def solved(inp):
    out = solve_input(inp)
    assert out["status"] in ("OPTIMAL", "FEASIBLE"), out["status"]
    return out["entries"]


def opts(seconds=20, workers=2):
    return options(timeLimitSeconds=seconds, numWorkers=workers)


class ExactWeeklyDemandTest(unittest.TestCase):
    def test_every_assignment_gets_exactly_its_periods(self):
        tuples = [("a", "S1", "T1", 5), ("b", "S1", "T2", 1), ("c", "S1", "T3", 3), ("d", "S2", "T1", 4), ("e", "S2", "T2", 2)]
        inp = make_input(5, 6, all_continue(6), tuples, opts=opts())
        entries = solved(inp)
        self.assertEqual(canonical.hard_problems(inp, entries), [])
        for aid, _s, _t, p in tuples:
            self.assertEqual(sum(1 for e in entries if e["assignmentId"] == aid), p)
        self.assertEqual(len(entries), sum(t[3] for t in tuples))

    def test_demand_is_per_section_not_per_requirement(self):
        """8A/8B/8C each need Math 5: three assignments of 5 = 15 periods, not 5."""
        tuples = [(f"math-{s}", s, "t-math", 5) for s in ("8A", "8B", "8C")]
        inp = make_input(5, 6, all_continue(6), tuples, opts=opts())
        entries = solved(inp)
        self.assertEqual(len(entries), 15)
        for s in ("8A", "8B", "8C"):
            self.assertEqual(sum(1 for e in entries if e["sectionId"] == s), 5)
        self.assertEqual(canonical.hard_problems(inp, entries), [])

    def test_a_single_period_subject_is_placed_once(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 1)], opts=opts())
        self.assertEqual(len(solved(inp)), 1)

    def test_a_subject_with_more_periods_than_days_is_still_exact(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 9)], opts=opts())
        entries = solved(inp)
        self.assertEqual(len(entries), 9)
        self.assertEqual(canonical.hard_problems(inp, entries), [])


class CollisionTest(unittest.TestCase):
    def test_a_section_never_has_two_lessons_in_one_slot(self):
        tuples = [(f"a{i}", "S", f"T{i}", 5) for i in range(6)]  # 30 periods fill the whole 5x6 week
        inp = make_input(5, 6, all_continue(6), tuples, opts=opts())
        entries = solved(inp)
        slots = {(e["dayOfWeek"], e["periodNumber"]) for e in entries}
        self.assertEqual(len(entries), 30)
        self.assertEqual(len(slots), 30)  # every slot used exactly once
        self.assertEqual(canonical.hard_problems(inp, entries), [])

    def test_a_teacher_never_teaches_two_sections_in_one_slot(self):
        tuples = [(f"a{i}", f"S{i}", "T", 5) for i in range(4)]
        inp = make_input(5, 6, all_continue(6), tuples, opts=opts())
        entries = solved(inp)
        slots = [(e["dayOfWeek"], e["periodNumber"]) for e in entries]
        self.assertEqual(len(slots), len(set(slots)))
        self.assertEqual(canonical.hard_problems(inp, entries), [])

    def test_8a_and_8b_with_the_same_teacher_never_share_a_slot(self):
        tuples = [("m8a", "8A", "T1", 5), ("m8b", "8B", "T1", 5), ("s8a", "8A", "T2", 4), ("s8b", "8B", "T2", 4)]
        inp = make_input(5, 6, all_continue(6), tuples, opts=opts())
        entries = solved(inp)
        t1 = {(e["dayOfWeek"], e["periodNumber"]) for e in entries if e["teacherId"] == "T1"}
        self.assertEqual(len(t1), 10)
        self.assertEqual(canonical.hard_problems(inp, entries), [])

    def test_a_full_latin_square_is_found(self):
        """3 sections x 3 teachers, one lesson each per pair, 3 slots: every row and column is used exactly once."""
        tuples = [(f"a{s}{t}", f"S{s}", f"T{t}", 1) for s in range(3) for t in range(3)]
        inp = make_input(1, 3, all_continue(3), tuples, opts=opts())
        entries = solved(inp)
        self.assertEqual(canonical.hard_problems(inp, entries), [])
        self.assertEqual(len(entries), 9)

    def test_tight_regular_instances_where_every_teacher_and_section_is_fully_booked(self):
        rnd = random.Random(12)
        for _ in range(6):
            n, D, K = 5, 3, 4
            W = D * K
            mult: dict[tuple[int, int], int] = {}
            for _c in range(W):
                perm = list(range(n))
                rnd.shuffle(perm)
                for t, s in enumerate(perm):
                    mult[(s, t)] = mult.get((s, t), 0) + 1
            tuples = [(f"a{s}-{t}", f"S{s}", f"T{t}", p) for (s, t), p in mult.items()]
            inp = make_input(D, K, all_continue(K), tuples, opts=opts(30))
            entries = solved(inp)
            self.assertEqual(canonical.hard_problems(inp, entries), [])
            self.assertEqual(len(entries), n * W)  # all 12 slots of all 5 sections


class CapacityTest(unittest.TestCase):
    def test_a_teacher_at_exactly_the_weekly_slots_is_fully_packed_without_collision(self):
        tuples = [(f"a{i}", f"S{i}", "T", 5) for i in range(6)]  # load 30 = W
        inp = make_input(5, 6, all_continue(6), tuples, opts=opts())
        entries = solved(inp)
        self.assertEqual(len({(e["dayOfWeek"], e["periodNumber"]) for e in entries}), 30)

    def test_a_teacher_at_the_32_period_limit_on_a_48_slot_week(self):
        tuples = [(f"a{i}", f"S{i}", "T", 4) for i in range(8)]
        inp = make_input(6, 8, all_continue(8), tuples, opts=opts(30))
        entries = solved(inp)
        self.assertEqual(sum(1 for e in entries if e["teacherId"] == "T"), 32)
        self.assertEqual(canonical.hard_problems(inp, entries), [])

    def test_no_teacher_exceeds_32_even_with_many_sections(self):
        tuples = [(f"a{i}", f"S{i}", f"T{i % 3}", 4) for i in range(24)]  # three teachers with 8 sections x 4 = 32
        inp = make_input(6, 8, all_continue(8), tuples, opts=opts(30))
        entries = solved(inp)
        loads = {}
        for e in entries:
            loads[e["teacherId"]] = loads.get(e["teacherId"], 0) + 1
        self.assertTrue(all(v <= 32 for v in loads.values()), loads)
        self.assertEqual(canonical.hard_problems(inp, entries), [])


class GridTest(unittest.TestCase):
    def test_only_configured_days_and_periods_are_used(self):
        tuples = [(f"a{i}", f"S{i % 3}", f"T{i}", 4) for i in range(3)]
        for D, K in itertools.product((3, 5, 6), (4, 7)):
            inp = make_input(D, K, all_continue(K), tuples, opts=opts())
            entries = solved(inp)
            self.assertTrue(all(e["dayOfWeek"] in DAYS_OF_WEEK[:D] for e in entries))
            self.assertTrue(all(1 <= e["periodNumber"] <= K for e in entries))

    def test_a_non_consecutive_day_set_uses_exactly_those_days(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 6)], opts=opts())
        inp["grid"]["days"] = [{"index": 0, "dayOfWeek": "MONDAY"}, {"index": 1, "dayOfWeek": "WEDNESDAY"}, {"index": 2, "dayOfWeek": "SATURDAY"}]
        entries = solved(inp)
        self.assertTrue(all(e["dayOfWeek"] in ("MONDAY", "WEDNESDAY", "SATURDAY") for e in entries))
        self.assertEqual(len(entries), 6)

    def test_every_entry_carries_the_ids_of_its_assignment(self):
        tuples = [("a", "S1", "T1", 3), ("b", "S2", "T1", 2)]
        inp = make_input(5, 6, all_continue(6), tuples, opts=opts())
        by_id = {a["id"]: a for a in inp["assignments"]}
        for e in solved(inp):
            a = by_id[e["assignmentId"]]
            self.assertEqual((e["sectionId"], e["subjectId"], e["teacherId"]), (a["sectionId"], a["subjectId"], a["teacherId"]))

    def test_entries_come_out_in_canonical_order(self):
        inp = make_input(5, 6, all_continue(6), [("b", "S1", "T1", 3), ("a", "S2", "T2", 3)], opts=opts())
        entries = solved(inp)
        order = [(e["assignmentId"], DAYS_OF_WEEK.index(e["dayOfWeek"]), e["periodNumber"]) for e in entries]
        self.assertEqual(order, sorted(order))


class StreamSeparationTest(unittest.TestCase):
    """The solver has no notion of grade or stream: stream matching is done by the Node normalizer (Phase 1) before
    the solver sees anything. These tests pin the two halves of that guarantee on the Python side."""

    def test_the_solver_input_has_no_place_for_grades_or_streams(self):
        from timetable_solver.contract import ContractError, parse_problem
        for path, key in (("sections", "streamId"), ("sections", "gradeId"), ("assignments", "streamId"), ("assignments", "gradeId")):
            inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 3)])
            inp[path][0][key] = "x"
            with self.assertRaises(ContractError):
                parse_problem(inp)

    def test_each_assignment_stays_on_its_own_section_in_a_streamed_layout(self):
        # Grade 11: Science sections 11S1/11S2 with Physics/Chemistry teachers, Commerce 11C1 with Accountancy
        tuples = [("p1", "11S1", "t-phy", 6), ("p2", "11S2", "t-phy", 6), ("c1", "11S1", "t-chem", 6), ("c2", "11S2", "t-chem", 6), ("acc", "11C1", "t-acc", 6)]
        inp = make_input(5, 6, all_continue(6), tuples, opts=opts())
        entries = solved(inp)
        subject_of = {a["id"]: a["subjectId"] for a in inp["assignments"]}
        commerce = {subject_of["acc"]}
        for e in entries:
            if e["sectionId"] == "11C1":
                self.assertIn(e["subjectId"], commerce)
            else:
                self.assertNotIn(e["subjectId"], commerce)
        self.assertEqual(canonical.hard_problems(inp, entries), [])


class GoldenProblemsTest(unittest.TestCase):
    def test_golden_10_section_problems_solve_to_valid_timetables(self):
        for case in golden_cases():
            if case["name"].startswith("s10"):
                inp = golden_input(case, opts=options(timeLimitSeconds=20, numWorkers=4), weights=NO_OBJECTIVE)
                entries = solved(inp)
                self.assertEqual(canonical.hard_problems(inp, entries), [], case["name"])


class TestsWithTheFullObjective(unittest.TestCase):
    """The same hard constraints must hold when the approved objective (WEIGHTS_V1) is active."""

    def check(self, tuples, D=5, K=6, seconds=8):
        inp = _make_input(D, K, all_continue(K), tuples, opts=options(timeLimitSeconds=seconds, numWorkers=2))
        out = solve_input(inp)
        self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])
        self.assertGreaterEqual(out["diagnostics"]["objectiveValue"], canonical.evaluate(inp, out["entries"])["weighted"])

    def test_shared_teachers_and_a_full_week(self):
        self.check([("a", "S1", "T1", 5), ("b", "S1", "T2", 5), ("c", "S1", "T3", 5), ("d", "S2", "T1", 5), ("e", "S2", "T2", 5), ("f", "S2", "T3", 5)])

    def test_a_teacher_at_capacity(self):
        self.check([(f"a{i}", f"S{i}", "T", 5) for i in range(6)])

    def test_three_sections_sharing_a_math_teacher(self):
        self.check([(f"m{s}", s, "t-math", 5) for s in ("8A", "8B", "8C")] + [(f"s{s}", s, "t-sci", 4) for s in ("8A", "8B", "8C")])


if __name__ == "__main__":
    unittest.main()
