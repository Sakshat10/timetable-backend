"""Why a search that was cut short ended: the attribution of `stoppedBy`.

CP-SAT's response carries no stop reason, so the solver infers it from how close each limit was when the search ended. The rule is built so a
stop is NEVER credited to the deterministic limit when the wall clock might have caused it:
    only the deterministic limit reached  -> DETERMINISTIC_LIMIT   (the only stop a reproducible run can promise to repeat)
    only the wall clock reached           -> TIME_LIMIT
    both reached (near-simultaneous)      -> LIMIT_AMBIGUOUS       (the evidence cannot say which one; repeatability is not claimed)
    neither reached, search cut short     -> TIME_LIMIT without reproducible mode (the wall clock is the only limit), LIMIT_AMBIGUOUS with it
"""
import time
import types
import unittest
from unittest import mock

from ortools.sat.python import cp_model

from timetable_solver.contract import STOPPED_BY, parse_problem, validate_output
from timetable_solver.solve import DETERMINISTIC_REACHED_FRACTION, WALL_CLOCK_REACHED_FRACTION, _stopped_by, solve
from tests.helpers import all_continue, make_input, options, solve_input

FEASIBLE, UNKNOWN = cp_model.FEASIBLE, cp_model.UNKNOWN


def problem_options(**over):
    return parse_problem(make_input(5, 6, all_continue(6), [("a", "S", "T", 3)], opts=options(**over))).options


def fake(det_time, wall_time):
    return types.SimpleNamespace(response_proto=types.SimpleNamespace(deterministic_time=det_time), wall_time=wall_time)


REPRO = dict(timeLimitSeconds=30, numWorkers=2, reproducible=True, deterministicTimeLimit=10.0)
PLAIN = dict(timeLimitSeconds=30, numWorkers=2, reproducible=False, deterministicTimeLimit=None)
REMAINING = 20.0  # wall limit 20 s: "reached" means >= 18 s (0.9); the deterministic limit is 10: "reached" means >= 9.5 (0.95)


class AttributionRuleTest(unittest.TestCase):
    def attribute(self, det, wall, *, status=FEASIBLE, repro=True):
        return _stopped_by(status, problem_options(**(REPRO if repro else PLAIN)), REMAINING, fake(det, wall))

    def test_the_documented_fractions(self):
        self.assertEqual((DETERMINISTIC_REACHED_FRACTION, WALL_CLOCK_REACHED_FRACTION), (0.95, 0.9))

    def test_only_the_deterministic_limit_reached_is_a_confirmed_deterministic_stop(self):
        for det, wall in ((10.0, 3.0), (12.0, 0.1), (9.5, 17.9), (10.0, 17.99)):
            self.assertEqual(self.attribute(det, wall), "DETERMINISTIC_LIMIT", f"det={det} wall={wall}")

    def test_only_the_wall_clock_reached_is_a_time_limit_stop(self):
        for det, wall in ((1.0, 20.0), (9.4, 18.0), (0.0, 19.9), (9.49, 25.0)):
            self.assertEqual(self.attribute(det, wall), "TIME_LIMIT", f"det={det} wall={wall}")

    def test_both_limits_reached_is_ambiguous_never_deterministic(self):
        for det, wall in ((10.0, 20.0), (9.5, 18.0), (11.0, 19.0), (9.6, 18.5), (10.0, 18.0)):
            self.assertEqual(self.attribute(det, wall), "LIMIT_AMBIGUOUS", f"det={det} wall={wall}")

    def test_the_thresholds_are_exact_at_their_boundaries(self):
        self.assertEqual(self.attribute(9.5, 5.0), "DETERMINISTIC_LIMIT")  # exactly 95% counts as reached
        self.assertEqual(self.attribute(9.499, 5.0), "LIMIT_AMBIGUOUS")  # a limit fired but neither measurement says which: never "deterministic"
        self.assertEqual(self.attribute(1.0, 18.0), "TIME_LIMIT")  # exactly 90% counts as reached
        self.assertEqual(self.attribute(1.0, 17.999), "LIMIT_AMBIGUOUS")
        self.assertEqual(self.attribute(9.5, 18.0), "LIMIT_AMBIGUOUS")
        self.assertEqual(self.attribute(9.5, 17.999), "DETERMINISTIC_LIMIT")  # the wall clock is clearly NOT near: confirmed
        self.assertEqual(self.attribute(9.499, 18.0), "TIME_LIMIT")

    def test_neither_threshold_reached_but_the_search_was_cut_short(self):
        # reproducible: either limit may have fired -> ambiguous, NEVER a confirmed deterministic stop
        self.assertEqual(self.attribute(1.0, 2.0), "LIMIT_AMBIGUOUS")
        self.assertEqual(self.attribute(9.4, 17.0), "LIMIT_AMBIGUOUS")
        # not reproducible: the wall clock is the only limit there is, so the cause is certain
        self.assertEqual(self.attribute(1.0, 2.0, repro=False), "TIME_LIMIT")

    def test_without_reproducible_mode_the_deterministic_limit_never_matters(self):
        for det, wall in ((999.0, 1.0), (999.0, 20.0), (0.0, 25.0)):
            self.assertNotIn(self.attribute(det, wall, repro=False), ("DETERMINISTIC_LIMIT", "LIMIT_AMBIGUOUS"), f"det={det} wall={wall}")
        self.assertEqual(self.attribute(999.0, 20.0, repro=False), "TIME_LIMIT")
        self.assertEqual(self.attribute(999.0, 1.0, repro=False), "TIME_LIMIT")  # cut short, and the wall clock is the only limit that can exist

    def test_the_other_statuses_do_not_depend_on_the_times(self):
        for det, wall in ((0.0, 0.0), (99.0, 99.0)):
            self.assertEqual(self.attribute(det, wall, status=cp_model.OPTIMAL), "OPTIMAL")
            self.assertEqual(self.attribute(det, wall, status=cp_model.INFEASIBLE), "INFEASIBLE")
            self.assertEqual(self.attribute(det, wall, status=cp_model.MODEL_INVALID), "ERROR")

    def test_unknown_is_attributed_exactly_like_feasible(self):
        self.assertEqual(self.attribute(10.0, 3.0, status=UNKNOWN), "DETERMINISTIC_LIMIT")
        self.assertEqual(self.attribute(1.0, 20.0, status=UNKNOWN), "TIME_LIMIT")
        self.assertEqual(self.attribute(10.0, 20.0, status=UNKNOWN), "LIMIT_AMBIGUOUS")

    def test_the_new_value_is_part_of_the_contract(self):
        self.assertIn("LIMIT_AMBIGUOUS", STOPPED_BY)
        self.assertEqual(STOPPED_BY[-1], "LIMIT_AMBIGUOUS")


class EndToEndAttributionTest(unittest.TestCase):
    """The same rule through the real solve(): real CP-SAT for the unambiguous stops, a stand-in solver for the near-simultaneous one (a real
    search cannot be steered to stop exactly at both limits)."""

    @staticmethod
    def tight(opts):
        tuples = [(f"a{s}{i}", f"S{s}", f"T{i}", p) for s in range(3) for i, p in enumerate((5, 4, 3))]
        return make_input(5, 6, [True, True, False, True, True, False], tuples, opts=opts)

    def test_a_real_search_ended_by_its_deterministic_limit_is_confirmed(self):
        out = solve_input(self.tight(options(timeLimitSeconds=60, numWorkers=2, seed=31337, reproducible=True, deterministicTimeLimit=1.0)))
        validate_output(out)
        self.assertIn(out["status"], ("FEASIBLE", "UNKNOWN"))
        self.assertEqual(out["diagnostics"]["stoppedBy"], "DETERMINISTIC_LIMIT")
        self.assertLess(out["diagnostics"]["wallSeconds"], 0.9 * 59)  # the wall clock was nowhere near its limit

    def test_a_real_search_ended_by_the_wall_clock_is_a_time_limit_stop(self):
        out = solve_input(self.tight(options(timeLimitSeconds=3, numWorkers=2, seed=31337, reproducible=True, deterministicTimeLimit=3000.0)))
        validate_output(out)
        if out["status"] != "OPTIMAL":  # (a proof of optimality within 3 s is possible on a fast machine and is not a stop by a limit)
            self.assertEqual(out["diagnostics"]["stoppedBy"], "TIME_LIMIT")

    def test_a_near_simultaneous_stop_is_reported_as_ambiguous_with_an_explanation(self):
        class Both:
            def __init__(self):
                self.parameters = types.SimpleNamespace()
                self.num_conflicts, self.num_branches, self.wall_time = 5, 7, 9.6  # >= 90% of the ~9.7 s wall limit
                self.response_proto = types.SimpleNamespace(deterministic_time=4.9)  # >= 95% of the 5.0 deterministic limit
                self.objective_value = 0.0
                self.best_objective_bound = 0.0

            def solve(self, model, callback=None):
                return UNKNOWN

            def boolean_value(self, var):
                return 0

        inp = self.tight(options(timeLimitSeconds=10, numWorkers=2, reproducible=True, deterministicTimeLimit=5.0))
        with mock.patch.object(cp_model, "CpSolver", Both):
            out = solve(parse_problem(inp), process_start=time.monotonic())
        validate_output(out)  # the contract accepts the new value
        self.assertEqual((out["status"], out["entries"]), ("UNKNOWN", []))
        self.assertEqual(out["diagnostics"]["stoppedBy"], "LIMIT_AMBIGUOUS")
        self.assertTrue(any("BOTH" in m and "not confirmed to be repeatable" in m for m in out["diagnostics"]["messages"]))

    def test_the_same_stand_in_with_only_the_deterministic_limit_reached_is_confirmed(self):
        class DeterministicOnly:
            def __init__(self):
                self.parameters = types.SimpleNamespace()
                self.num_conflicts, self.num_branches, self.wall_time = 5, 7, 2.0
                self.response_proto = types.SimpleNamespace(deterministic_time=5.0)
                self.objective_value = 0.0
                self.best_objective_bound = 0.0

            def solve(self, model, callback=None):
                return UNKNOWN

            def boolean_value(self, var):
                return 0

        inp = self.tight(options(timeLimitSeconds=10, numWorkers=2, reproducible=True, deterministicTimeLimit=5.0))
        with mock.patch.object(cp_model, "CpSolver", DeterministicOnly):
            out = solve(parse_problem(inp), process_start=time.monotonic())
        self.assertEqual(out["diagnostics"]["stoppedBy"], "DETERMINISTIC_LIMIT")
        self.assertFalse(any("BOTH" in m for m in out["diagnostics"]["messages"]))


if __name__ == "__main__":
    unittest.main()
