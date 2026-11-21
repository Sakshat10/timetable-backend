"""Solver status behaviour: OPTIMAL, FEASIBLE (medium and large), UNKNOWN, INFEASIBLE, MODEL_INVALID.

The solver reports exactly what CP-SAT said. It never substitutes a baseline: a missing solution is UNKNOWN and an
impossible problem is INFEASIBLE, and Node decides what that means for the run.
"""
import time
import unittest
from unittest import mock

from ortools.sat.python import cp_model

from timetable_solver.contract import parse_problem, validate_output
from timetable_solver.solve import solve
from tests import canonical
from tests.helpers import (
    all_continue, golden_cases, golden_input, make_input, options, solve_input, synthetic_heavy,
)


def fake_solver(status, ones=False):
    """A stand-in for cp_model.CpSolver that reports a chosen status. With ones=True every Boolean reads as 1."""
    import types

    class Fake:
        def __init__(self):
            self.parameters = types.SimpleNamespace()
            self.num_conflicts = 7
            self.num_branches = 11
            self.wall_time = 0.01
            self.objective_value = 0.0
            self.best_objective_bound = 0.0
            self.response_proto = types.SimpleNamespace(deterministic_time=0.0)

        def solve(self, model, callback=None):
            return status

        def boolean_value(self, var):
            return 1 if ones else 0

    return Fake


def golden(prefix):
    return next(c for c in golden_cases() if c["name"].startswith(prefix))


class OptimalTest(unittest.TestCase):
    def test_one_section_one_subject_is_optimal_and_perfect(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=20))
        out = solve_input(inp)
        validate_output(out)
        d = out["diagnostics"]
        self.assertEqual(out["status"], "OPTIMAL")
        self.assertEqual(len(out["entries"]), 5)
        self.assertEqual((d["objectiveValue"], d["bestObjectiveBound"], d["stoppedBy"]), (0.0, 0.0, "OPTIMAL"))
        self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])
        self.assertEqual(len({e["dayOfWeek"] for e in out["entries"]}), 5)  # spread: one per day

    def test_the_golden_10_section_school_is_solved_to_proven_optimality(self):
        inp = golden_input(golden("s10_5d6p_light"), opts=options(timeLimitSeconds=60, numWorkers=4))
        out = solve_input(inp)
        validate_output(out)
        self.assertEqual(out["status"], "OPTIMAL")
        self.assertEqual(out["diagnostics"]["stoppedBy"], "OPTIMAL")
        self.assertEqual(out["diagnostics"]["objectiveValue"], 0.0)
        self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])
        self.assertEqual(canonical.evaluate(inp, out["entries"])["weighted"], 0)

    def test_optimal_with_no_objective_terms_at_all(self):
        inp = make_input(1, 3, all_continue(3), [("a", "S", "T", 1)], weights={n: 0 for n in canonical.TERMS})
        out = solve_input(inp)
        self.assertEqual((out["status"], out["diagnostics"]["objectiveValue"]), ("OPTIMAL", 0.0))


class FeasibleTest(unittest.TestCase):
    def check_feasible(self, inp, out, budget):
        validate_output(out)
        d = out["diagnostics"]
        self.assertEqual(out["status"], "FEASIBLE")
        self.assertEqual(d["stoppedBy"], "TIME_LIMIT")
        self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])
        self.assertEqual(len(out["entries"]), sum(a["periodsPerWeek"] for a in inp["assignments"]))
        truth = canonical.evaluate(inp, out["entries"])["weighted"]
        self.assertGreaterEqual(d["objectiveValue"], truth)  # the solver number may carry slack, never less than the truth
        self.assertLessEqual(d["bestObjectiveBound"], d["objectiveValue"])
        self.assertLess(d["wallSeconds"], budget + 3, "the whole process stays within its budget (plus start-up slack)")

    def test_a_medium_50_section_school_is_feasible_not_optimal(self):
        inp = golden_input(golden("s50_5d8p"), opts=options(timeLimitSeconds=8, numWorkers=4))
        self.check_feasible(inp, solve_input(inp), 8)

    def test_a_large_100_section_school_is_feasible(self):
        tuples = synthetic_heavy(100, D=5, K=8)
        self.assertGreaterEqual(len({t[1] for t in tuples}), 60)
        inp = make_input(5, 8, all_continue(8), tuples, opts=options(timeLimitSeconds=20, numWorkers=4))
        self.check_feasible(inp, solve_input(inp), 20)

    def test_the_time_budget_includes_everything_the_process_did_before_solving(self):
        inp = golden_input(golden("s50_5d8p"), opts=options(timeLimitSeconds=6, numWorkers=2))
        start = time.monotonic() - 2.0  # pretend 2 s were already spent on start-up and validation
        out = solve(parse_problem(inp), process_start=start)
        self.assertLess(out["diagnostics"]["wallSeconds"], 6 + 3)  # counted from process start, so ~4 s of solving at most


class UnknownTest(unittest.TestCase):
    def test_budget_exhausted_before_the_solve_starts_is_unknown_without_solving(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=5))
        out = solve(parse_problem(inp), process_start=time.monotonic() - 100)
        validate_output(out)
        self.assertEqual((out["status"], out["entries"]), ("UNKNOWN", []))
        self.assertEqual(out["diagnostics"]["stoppedBy"], "TIME_LIMIT")
        self.assertTrue(any("exhausted before the solve" in m for m in out["diagnostics"]["messages"]))
        self.assertIsNotNone(out["diagnostics"]["numBooleans"])  # the model was built; it simply was not solved
        self.assertIsNone(out["diagnostics"]["conflicts"])

    def test_cpsat_itself_returning_unknown_at_a_deterministic_limit(self):
        for _ in range(3):  # stable, not a lucky run
            inp = golden_input(golden("s50_5d8p"), opts=options(timeLimitSeconds=60, numWorkers=2, reproducible=True, deterministicTimeLimit=0.001))
            out = solve_input(inp)
            validate_output(out)
            self.assertEqual((out["status"], out["entries"]), ("UNKNOWN", []))
            self.assertEqual(out["diagnostics"]["stoppedBy"], "DETERMINISTIC_LIMIT")
            self.assertIsNone(out["diagnostics"]["objectiveValue"])
            self.assertIsNone(out["diagnostics"]["bestObjectiveBound"])
            self.assertTrue(any("no solution found within the budget" in m for m in out["diagnostics"]["messages"]))

    def test_a_one_second_budget_on_50_sections_is_unknown_or_a_first_solution_never_a_substitute(self):
        inp = golden_input(golden("s50_5d8p"), opts=options(timeLimitSeconds=1, numWorkers=2))
        out = solve_input(inp)
        validate_output(out)
        self.assertIn(out["status"], ("UNKNOWN", "FEASIBLE"))
        if out["status"] == "UNKNOWN":
            self.assertEqual((out["entries"], out["diagnostics"]["stoppedBy"]), ([], "TIME_LIMIT"))
        else:
            self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])

    def test_unknown_never_carries_entries(self):
        inp = golden_input(golden("s10_6d8p"), opts=options(timeLimitSeconds=60, reproducible=True, deterministicTimeLimit=0.001))
        out = solve_input(inp)
        self.assertEqual((out["status"], len(out["entries"])), ("UNKNOWN", 0))


class InfeasibleTest(unittest.TestCase):
    def certificate(self, inp, *needles):
        out = solve_input(inp)
        validate_output(out)
        self.assertEqual((out["status"], out["entries"]), ("INFEASIBLE", []))
        self.assertEqual(out["diagnostics"]["stoppedBy"], "INFEASIBLE")
        text = " ".join(out["diagnostics"]["messages"])
        for needle in needles:
            self.assertIn(needle, text)
        self.assertIsNone(out["diagnostics"]["conflicts"])  # decided before CP-SAT ran
        return out

    def test_teacher_load_above_the_weekly_slots(self):
        self.certificate(make_input(2, 3, all_continue(3), [("a", "S1", "T1", 4), ("b", "S2", "T1", 3)]), "teacher T1", "7 periods", "limit of 6")

    def test_section_demand_above_the_weekly_slots(self):
        self.certificate(make_input(2, 3, all_continue(3), [("a", "S1", "T1", 4), ("b", "S1", "T2", 3)]), "section S1", "7 periods")

    def test_teacher_load_above_the_declared_weekly_capacity(self):
        self.certificate(make_input(5, 6, all_continue(6), [("a", "S1", "T1", 3), ("b", "S2", "T1", 2)], teacher_cap=4), "teacher T1", "5 periods", "limit of 4")

    def test_teacher_load_above_the_maximum_of_33_against_32(self):
        tuples = [(f"a{i}", f"S{i}", "T1", 5) for i in range(6)] + [("x", "S9", "T1", 3)]  # 33 periods
        inp = make_input(6, 8, all_continue(8), tuples)
        self.assertEqual(sum(t[3] for t in tuples), 33)
        self.certificate(inp, "teacher T1", "33 periods", "limit of 32")

    def test_exactly_32_periods_is_accepted(self):
        tuples = [(f"a{i}", f"S{i}", "T1", 4) for i in range(8)]  # 32 periods
        out = solve_input(make_input(6, 8, all_continue(8), tuples, opts=options(timeLimitSeconds=20)))
        self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"))

    def test_the_grid_maximum_per_teacher_is_honoured(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S1", "T1", 3), ("b", "S2", "T1", 2)])
        inp["grid"]["maxTeacherPeriodsPerWeek"] = 4
        self.certificate(inp, "limit of 4")

    def test_every_violation_is_named(self):
        inp = make_input(1, 3, all_continue(3), [("a", "S1", "T1", 2), ("b", "S1", "T2", 2), ("c", "S2", "T1", 2)])
        out = self.certificate(inp, "teacher T1", "section S1")
        self.assertGreaterEqual(len(out["diagnostics"]["messages"]), 3)

    def test_cpsat_proves_contradictory_locked_entries_infeasible(self):
        # a real CP-SAT INFEASIBLE: two lessons of the same section locked into the same slot
        tuples = [("a", "S1", "T1", 1), ("b", "S1", "T2", 1)]
        inp = make_input(2, 3, all_continue(3), tuples, fixed=[("a", 0, 1), ("b", 0, 1)])
        out = solve_input(inp)
        validate_output(out)
        self.assertEqual((out["status"], out["entries"]), ("INFEASIBLE", []))
        self.assertEqual(out["diagnostics"]["stoppedBy"], "INFEASIBLE")
        self.assertTrue(any("CP-SAT proved" in m for m in out["diagnostics"]["messages"]))
        self.assertIsNotNone(out["diagnostics"]["conflicts"])  # CP-SAT actually ran

    def test_locked_entries_that_collide_on_a_teacher_are_infeasible(self):
        tuples = [("a", "S1", "T1", 1), ("b", "S2", "T1", 1)]
        out = solve_input(make_input(2, 3, all_continue(3), tuples, fixed=[("a", 1, 2), ("b", 1, 2)]))
        self.assertEqual(out["status"], "INFEASIBLE")

    def test_more_locked_entries_than_periods_is_infeasible(self):
        out = solve_input(make_input(2, 3, all_continue(3), [("a", "S1", "T1", 1)], fixed=[("a", 0, 1), ("a", 1, 1)]))
        self.assertEqual(out["status"], "INFEASIBLE")

    def test_consistent_locked_entries_are_honoured_exactly(self):
        inp = make_input(2, 3, all_continue(3), [("a", "S1", "T1", 2), ("b", "S1", "T2", 1)], fixed=[("a", 1, 3), ("b", 0, 2)])
        out = solve_input(inp)
        self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"))
        placed = {(e["assignmentId"], e["dayOfWeek"], e["periodNumber"]) for e in out["entries"]}
        self.assertIn(("a", "TUESDAY", 3), placed)
        self.assertIn(("b", "MONDAY", 2), placed)
        self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])


class ModelInvalidTest(unittest.TestCase):
    def test_a_model_cpsat_rejects_is_reported_as_model_invalid(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 5)])
        with mock.patch.object(cp_model.CpModel, "validate", return_value="forced validation error"):
            out = solve_input(inp)
        validate_output(out)
        self.assertEqual((out["status"], out["entries"]), ("MODEL_INVALID", []))
        self.assertEqual(out["diagnostics"]["stoppedBy"], "ERROR")
        self.assertTrue(any("forced validation error" in m for m in out["diagnostics"]["messages"]))

    def test_a_model_invalid_status_from_the_solve_itself(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 5)])
        with mock.patch.object(cp_model, "CpSolver", fake_solver(cp_model.MODEL_INVALID)):
            out = solve_input(inp)
        validate_output(out)
        self.assertEqual((out["status"], out["entries"], out["diagnostics"]["stoppedBy"]), ("MODEL_INVALID", [], "ERROR"))

    def test_the_solver_never_invents_a_result(self):
        """Whatever CP-SAT reports other than OPTIMAL/FEASIBLE, the output has no entries."""
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 5)])
        for status, expected in ((cp_model.UNKNOWN, "UNKNOWN"), (cp_model.INFEASIBLE, "INFEASIBLE"), (cp_model.MODEL_INVALID, "MODEL_INVALID")):
            with mock.patch.object(cp_model, "CpSolver", fake_solver(status)):
                out = solve_input(inp)
            validate_output(out)
            self.assertEqual((out["status"], out["entries"]), (expected, []))

    def test_every_cpsat_status_maps_to_exactly_one_contract_status(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 5)])
        seen = {}
        for status, expected in ((cp_model.OPTIMAL, "OPTIMAL"), (cp_model.FEASIBLE, "FEASIBLE"), (cp_model.UNKNOWN, "UNKNOWN"),
                                 (cp_model.INFEASIBLE, "INFEASIBLE"), (cp_model.MODEL_INVALID, "MODEL_INVALID")):
            with mock.patch.object(cp_model, "CpSolver", fake_solver(status, ones=True)):
                seen[expected] = solve_input(inp)["status"]
        self.assertEqual(seen, {k: k for k in seen})


if __name__ == "__main__":
    unittest.main()
