"""Objective agreement with the Phase 1 CANONICAL metric definitions.

Method: lock every lesson of a timetable in place with fixedEntries. The model can then only choose its soft
variables, whose optimum is exactly the canonical weighted objective of those entries. Putting a weight of 1 on a
single term (and 0 on the rest) isolates that term. Each result is compared with (a) a hand-computed number and
(b) the independent evaluator in tests/canonical.py. The golden fixtures exported from the TypeScript side give the
same check on realistic timetables.
"""
import unittest

from tests import canonical
from tests.helpers import (
    TERMS, WEIGHTS_V1, all_continue, entry_for, golden_cases, golden_entries, golden_input, make_input, solve_input,
    weights_only, with_entries_fixed,
)

BREAK_AFTER = lambda K, *after: [(k + 1) not in after and k < K - 1 for k in range(K)]  # noqa: E731 - 1-based periods followed by a break


def model_objective(inp, entries, weights=None) -> int:
    """The CP-SAT optimum with all lessons locked = the objective the model assigns to these entries."""
    out = solve_input(with_entries_fixed(inp, entries, weights))
    assert out["status"] == "OPTIMAL", out["status"]
    assert len(out["entries"]) == len(entries)
    return int(round(out["diagnostics"]["objectiveValue"]))


class TermCase:
    """One hand-built timetable and the per-term counts worked out by hand."""

    def __init__(self, inp, entries, expected):
        self.inp, self.entries, self.expected = inp, entries, expected


def teacher_run_case(periods, continues, K=6, D=1):
    """One teacher T with single-period lessons in distinct sections at the given 1-based periods on day 0."""
    tuples = [(f"a{i}", f"S{i}", "T", 1) for i in range(len(periods))]
    inp = make_input(D, K, continues, tuples)
    return inp, [entry_for(inp, f"a{i}", 0, p) for i, p in enumerate(periods)]


class SingleTermTest(unittest.TestCase):
    def check_term(self, inp, entries, term, expected):
        model_value = model_objective(inp, entries, weights_only(term))
        independent = canonical.evaluate(inp, entries, weights_only(term))["weighted"]
        self.assertEqual(independent, expected, f"{term}: independent evaluator")
        self.assertEqual(model_value, expected, f"{term}: CP-SAT model")

    # ---- teacherRun3 / teacherRun4Plus ------------------------------------------------------------------
    def test_runs_of_3_4_5_6(self):
        for periods, run3, run4 in [([1, 2, 3], 1, 0), ([1, 2, 3, 4], 2, 1), ([1, 2, 3, 4, 5], 3, 2), ([1, 2, 3, 4, 5, 6], 4, 3)]:
            inp, entries = teacher_run_case(periods, all_continue(6))
            self.check_term(inp, entries, "teacherRun3", run3)
            self.check_term(inp, entries, "teacherRun4Plus", run4)

    def test_two_lessons_and_a_gap_are_free(self):
        for periods in ([1, 2], [1, 3], [1, 2, 4, 5], [2, 3, 5, 6]):
            inp, entries = teacher_run_case(periods, all_continue(6))
            self.check_term(inp, entries, "teacherRun3", 0)
            self.check_term(inp, entries, "teacherRun4Plus", 0)

    def test_two_then_gap_then_three(self):
        inp, entries = teacher_run_case([1, 2, 4, 5, 6], all_continue(6))
        self.check_term(inp, entries, "teacherRun3", 1)
        self.check_term(inp, entries, "teacherRun4Plus", 0)

    # ---- continuesIntoNext: a break / lunch / timing event ends the run ---------------------------------------
    def test_a_break_after_period_2_splits_periods_1_to_3(self):
        inp, entries = teacher_run_case([1, 2, 3], BREAK_AFTER(6, 2))
        self.check_term(inp, entries, "teacherRun3", 0)
        self.check_term(inp, entries, "teacherRun4Plus", 0)

    def test_the_same_periods_without_the_break_are_a_run(self):
        inp, entries = teacher_run_case([1, 2, 3], all_continue(6))
        self.check_term(inp, entries, "teacherRun3", 1)

    def test_periods_3_to_5_after_that_break_are_a_run(self):
        inp, entries = teacher_run_case([3, 4, 5], BREAK_AFTER(6, 2))
        self.check_term(inp, entries, "teacherRun3", 1)

    def test_a_break_after_period_3_keeps_1_to_3_a_run_but_splits_the_4_window(self):
        inp, entries = teacher_run_case([1, 2, 3, 4], BREAK_AFTER(6, 3))
        self.check_term(inp, entries, "teacherRun3", 1)
        self.check_term(inp, entries, "teacherRun4Plus", 0)

    def test_breaks_after_every_period_leave_no_run(self):
        inp, entries = teacher_run_case([1, 2, 3, 4], [False] * 6)
        self.check_term(inp, entries, "teacherRun3", 0)
        self.check_term(inp, entries, "teacherRun4Plus", 0)

    def test_a_break_inside_a_window_of_four(self):
        for after, run3, run4 in [(1, 1, 0), (2, 0, 0), (3, 1, 0), (4, 2, 1)]:
            inp, entries = teacher_run_case([1, 2, 3, 4], BREAK_AFTER(6, after))
            self.check_term(inp, entries, "teacherRun3", run3)
            self.check_term(inp, entries, "teacherRun4Plus", run4)

    def test_runs_are_counted_per_day(self):
        tuples = [(f"a{i}", f"S{i}", "T", 1) for i in range(6)]
        inp = make_input(2, 6, all_continue(6), tuples)
        entries = [entry_for(inp, f"a{i}", 0, 1 + i) for i in range(3)] + [entry_for(inp, f"a{3 + i}", 1, 4 + i) for i in range(3)]
        self.check_term(inp, entries, "teacherRun3", 2)

    # ---- the rule for teachers with weekly load < 3 ---------------------------------------------------------
    def test_a_teacher_with_weekly_load_2_is_excluded_from_the_daily_load_term(self):
        tuples = [("a", "SA", "T", 1), ("b", "SB", "T", 1)]
        inp = make_input(5, 6, all_continue(6), tuples)
        entries = [entry_for(inp, "a", 0, 1), entry_for(inp, "b", 0, 2)]  # both on Monday: would be 1 excess if scored
        self.check_term(inp, entries, "dailyLoadExcess", 0)
        self.check_term(inp, entries, "sectionHoles", 1)  # SB starts late; the teacher is irrelevant to this term

    def test_a_teacher_with_weekly_load_3_on_one_day_is_scored(self):
        tuples = [(f"a{i}", f"S{i}", "T", 1) for i in range(3)]
        inp = make_input(5, 6, all_continue(6), tuples)
        entries = [entry_for(inp, f"a{i}", 0, 1 + i) for i in range(3)]
        # cap = ceil(3/5) = 1, three lessons on Monday -> excess 2 (sections hold 1 lesson each: no excess)
        self.check_term(inp, entries, "dailyLoadExcess", 2)

    def test_a_teacher_with_weekly_load_2_has_no_run_terms_even_with_adjacent_lessons(self):
        inp, entries = teacher_run_case([1, 2], all_continue(6))
        for term in ("teacherRun3", "teacherRun4Plus"):
            self.check_term(inp, entries, term, 0)

    def test_load_exactly_3_with_three_in_a_row_is_scored_by_the_run_term(self):
        inp, entries = teacher_run_case([4, 5, 6], all_continue(6))
        self.check_term(inp, entries, "teacherRun3", 1)

    def test_the_model_creates_no_teacher_variables_for_load_below_3(self):
        from timetable_solver.contract import parse_problem
        from timetable_solver.model import build_model
        light = make_input(5, 6, all_continue(6), [("a", "SA", "T", 1), ("b", "SB", "T", 1)], weights={**weights_only("teacherRun3"), "teacherRun4Plus": 1})
        self.assertEqual(sum(build_model(parse_problem(light)).soft_var_counts.values()), 0)
        heavy = make_input(5, 6, all_continue(6), [(f"a{i}", f"S{i}", "T", 1) for i in range(3)], weights={**weights_only("teacherRun3"), "teacherRun4Plus": 1})
        self.assertGreater(sum(build_model(parse_problem(heavy)).soft_var_counts.values()), 0)

    def test_a_full_section_gets_no_section_variables_and_a_free_one_does(self):
        from timetable_solver.contract import parse_problem
        from timetable_solver.model import build_model
        full = make_input(5, 6, all_continue(6), [(f"a{i}", "S", f"T{i}", 5) for i in range(6)], weights=weights_only("sectionHoles"))  # demand 30 = W
        free = make_input(5, 6, all_continue(6), [(f"a{i}", "S", f"T{i}", 5) for i in range(5)], weights=weights_only("sectionHoles"))  # demand 25 < W
        self.assertEqual(sum(build_model(parse_problem(full)).soft_var_counts.values()), 0)
        self.assertGreater(sum(build_model(parse_problem(free)).soft_var_counts.values()), 0)

    # ---- subjectSameDayExcess ---------------------------------------------------------------------------------
    def spread(self, p, D, K, placement):
        inp = make_input(D, K, all_continue(K), [("a", "S", "T", p)])
        return inp, [entry_for(inp, "a", d, k) for d, k in placement]

    def test_spread_cases(self):
        cases = [
            (1, 5, 6, [(0, 1)], 0),                                       # one period: never penalised
            (2, 5, 6, [(0, 1), (1, 1)], 0),                               # two days
            (2, 5, 6, [(0, 1), (0, 2)], 1),                               # same day
            (3, 5, 6, [(0, 1), (0, 2), (0, 3)], 2),                       # all on one day, cap 1
            (5, 5, 6, [(0, 1), (1, 1), (2, 1), (3, 1), (4, 1)], 0),       # one per day
            (5, 5, 6, [(0, 1), (0, 2), (2, 1), (3, 1), (4, 1)], 1),       # a double
            (8, 5, 6, [(0, 1), (0, 2), (1, 1), (1, 2), (2, 1), (2, 2), (3, 1), (4, 1)], 0),   # 2,2,2,1,1 with cap 2
            (8, 5, 6, [(0, 1), (0, 2), (0, 3), (1, 1), (1, 2), (2, 1), (3, 1), (4, 1)], 1),   # 3,2,1,1,1 with cap 2
            (8, 5, 2, [(0, 1), (0, 2), (1, 1), (1, 2), (2, 1), (2, 2), (3, 1), (3, 2)], 0),   # cap 2 >= K 2: skipped
        ]
        for p, D, K, placement, expected in cases:
            inp, entries = self.spread(p, D, K, placement)
            self.check_term(inp, entries, "subjectSameDayExcess", expected)

    # ---- sectionHoles ------------------------------------------------------------------------------------------
    def holes(self, periods, K=6):
        tuples = [(f"a{i}", "S", f"T{i}", 1) for i in range(len(periods))]
        inp = make_input(1, K, all_continue(K), tuples)
        return inp, [entry_for(inp, f"a{i}", 0, p) for i, p in enumerate(periods)]

    def test_hole_cases(self):
        for periods, expected in [([1, 2, 3], 0), ([1, 3, 5], 2), ([2, 3, 4], 1), ([1, 2, 3, 5], 1), ([1, 2, 3, 4, 5, 6], 0), ([6], 1), ([1], 0)]:
            inp, entries = self.holes(periods)
            self.check_term(inp, entries, "sectionHoles", expected)

    def test_holes_are_counted_per_day_and_ignore_breaks(self):
        tuples = [("a", "S", "T1", 1), ("b", "S", "T2", 1), ("c", "S", "T3", 1), ("d", "S", "T4", 1)]
        inp = make_input(2, 6, BREAK_AFTER(6, 2), tuples)
        entries = [entry_for(inp, "a", 0, 1), entry_for(inp, "b", 0, 3), entry_for(inp, "c", 1, 2), entry_for(inp, "d", 1, 3)]
        self.check_term(inp, entries, "sectionHoles", 2)  # day 0: 1,3 -> 1 hole; day 1: 2,3 -> 1 (late start); a break does not matter

    # ---- dailyLoadExcess -----------------------------------------------------------------------------------------
    def test_teacher_and_section_daily_load(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S1", "T", 12)])
        counts = [(0, 5), (1, 3), (2, 2), (3, 1), (4, 1)]
        entries = [entry_for(inp, "a", d, k + 1) for d, n in counts for k in range(n)]
        # teacher: load 12 over 5 days, cap 3: 5 lessons on day 0 -> 2. Section S1: demand 12, cap 3 -> 2. Total 4.
        self.check_term(inp, entries, "dailyLoadExcess", 4)

    def test_a_cap_of_at_least_K_skips_the_term(self):
        inp = make_input(1, 6, all_continue(6), [("a", "S", "T", 6)])
        entries = [entry_for(inp, "a", 0, k) for k in range(1, 7)]
        self.check_term(inp, entries, "dailyLoadExcess", 0)

    def test_a_perfectly_even_week_costs_nothing(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S1", "T", 10)])
        entries = [entry_for(inp, "a", d, k) for d in range(5) for k in (1, 2)]
        self.check_term(inp, entries, "dailyLoadExcess", 0)

    # ---- weights -------------------------------------------------------------------------------------------------
    def test_weights_come_from_the_input_and_combine_linearly(self):
        inp, entries = teacher_run_case([1, 2, 3, 4], all_continue(6))
        terms = canonical.evaluate(inp, entries)["terms"]
        self.assertEqual((terms["teacherRun3"], terms["teacherRun4Plus"]), (2, 1))
        for weights in (WEIGHTS_V1, {**WEIGHTS_V1, "teacherRun4Plus": 100}, {name: 1 for name in TERMS}, {name: 0 for name in TERMS}):
            expected = sum(terms[n] * weights[n] for n in TERMS)
            self.assertEqual(canonical.evaluate(inp, entries, weights)["weighted"], expected)
            if any(weights.values()):
                self.assertEqual(model_objective(inp, entries, weights), expected, weights)

    def test_zero_weights_leave_no_soft_variables_and_a_zero_objective(self):
        inp, entries = teacher_run_case([1, 2, 3, 4], all_continue(6))
        zero = with_entries_fixed(inp, entries, {name: 0 for name in TERMS})
        out = solve_input(zero)
        self.assertEqual((out["status"], out["diagnostics"]["objectiveValue"]), ("OPTIMAL", 0.0))

    def test_a_run_of_4_with_the_approved_weights_scores_14_plus_the_section_holes(self):
        # the TypeScript test of the same shape: teacher run of 4 = 2*3 + 8 = 14; S1..S4 each hold one lesson, S2..S4 start late = 3 holes * 4
        inp, entries = teacher_run_case([1, 2, 3, 4], all_continue(6))
        self.assertEqual(model_objective(inp, entries, WEIGHTS_V1), 14 + 12)


class GoldenParityTest(unittest.TestCase):
    """The golden fixtures: expected values were computed by the independent Phase 0 evaluator and are verified
    by the TypeScript evaluator in test-timetable-generation-core.ts."""

    @classmethod
    def setUpClass(cls):
        cls.cases = golden_cases()

    def test_the_golden_set_covers_every_term_with_a_non_zero_value(self):
        for term in TERMS:
            self.assertTrue(any(c["expected"]["terms"][term] > 0 for c in self.cases), term)

    def test_the_python_evaluator_reproduces_the_golden_values(self):
        for case in self.cases:
            inp = golden_input(case)
            entries = golden_entries(case, inp)
            self.assertEqual(canonical.hard_problems(inp, entries), [], case["name"])
            ev = canonical.evaluate(inp, entries)
            self.assertEqual(ev["terms"], case["expected"]["terms"], case["name"])
            self.assertEqual(ev["weighted"], case["expected"]["weightedObjective"], case["name"])

    def test_the_cpsat_model_assigns_the_golden_weighted_objective(self):
        for case in self.cases:
            inp = golden_input(case)
            entries = golden_entries(case, inp)
            self.assertEqual(model_objective(inp, entries), case["expected"]["weightedObjective"], case["name"])

    def test_each_term_of_the_cpsat_model_equals_the_golden_term(self):
        for case in self.cases:
            inp = golden_input(case)
            entries = golden_entries(case, inp)
            for term in TERMS:
                self.assertEqual(model_objective(inp, entries, weights_only(term)), case["expected"]["terms"][term], f"{case['name']}: {term}")


if __name__ == "__main__":
    unittest.main()
