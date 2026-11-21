"""Phase 7E: non-empty fixedEntries (locked lessons) end to end through the solver.

Python already enforced `x == 1` for every fixed entry and validated their structure (tests/test_input_validation.py and
tests/test_statuses.py cover single, contradictory and impossible fixed entries). These tests add what Phase 7E depends on: PARTIAL locks on
realistic problems, exact placement alongside every hard constraint, independence from the order of the fixed entries, and the fact that
a lock can never improve the objective. No production Python was changed for them: there was no missing behaviour.
"""
import copy
import random
import unittest

from timetable_solver.contract import validate_output
from tests import canonical
from tests.helpers import (
    all_continue, entry_for, make_input, options, run_cli, solve_input, synthetic_heavy, weights_only,
)

D, K = 5, 6


def small_problem(**kw):
    tuples = [
        ("m1", "S1", "TM", 5), ("m2", "S2", "TM", 5), ("m3", "S3", "TM", 5),
        ("c1", "S1", "TC", 4), ("c2", "S2", "TC", 4), ("c3", "S3", "TC", 4),
        ("e1", "S1", "TE", 3), ("e2", "S2", "TE", 3), ("e3", "S3", "TE", 3),
    ]
    return make_input(D, K, all_continue(K), tuples, **kw)


def placed(out):
    return {(e["assignmentId"], e["dayOfWeek"], e["periodNumber"]) for e in out["entries"]}


class PartialLocksTest(unittest.TestCase):
    def test_several_partial_locks_are_kept_exactly_and_every_hard_constraint_holds(self):
        base = small_problem(opts=options(timeLimitSeconds=30))
        free = solve_input(base)
        self.assertIn(free["status"], ("OPTIMAL", "FEASIBLE"))
        rnd = random.Random(7)
        chosen = rnd.sample(free["entries"], 12)
        inp = copy.deepcopy(base)
        inp["fixedEntries"] = [{"assignmentId": e["assignmentId"], "dayOfWeek": e["dayOfWeek"], "periodNumber": e["periodNumber"]} for e in chosen]
        out = solve_input(inp)
        validate_output(out)
        self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"))
        for e in chosen:
            self.assertIn((e["assignmentId"], e["dayOfWeek"], e["periodNumber"]), placed(out), "a locked lesson was moved or dropped")
        self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])
        self.assertEqual(len(out["entries"]), sum(a["periodsPerWeek"] for a in inp["assignments"]))

    def test_one_lock_two_locks_and_all_but_one_locked(self):
        base = small_problem(opts=options(timeLimitSeconds=30))
        free = solve_input(base)
        for count in (1, 2, len(free["entries"]) - 1):
            chosen = free["entries"][:count]
            inp = copy.deepcopy(base)
            inp["fixedEntries"] = [{"assignmentId": e["assignmentId"], "dayOfWeek": e["dayOfWeek"], "periodNumber": e["periodNumber"]} for e in chosen]
            out = solve_input(inp)
            self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"), f"{count} locks")
            self.assertTrue({(e["assignmentId"], e["dayOfWeek"], e["periodNumber"]) for e in chosen} <= placed(out), f"{count} locks")
            self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])

    def test_a_larger_school_with_locks(self):
        tuples = synthetic_heavy(12, D=5, K=8, seed=3, subjects=8)
        base = make_input(5, 8, all_continue(8), tuples, opts=options(timeLimitSeconds=15, numWorkers=4))
        free = solve_input(base)
        self.assertIn(free["status"], ("OPTIMAL", "FEASIBLE"))
        chosen = random.Random(11).sample(free["entries"], 40)
        inp = copy.deepcopy(base)
        inp["fixedEntries"] = [{"assignmentId": e["assignmentId"], "dayOfWeek": e["dayOfWeek"], "periodNumber": e["periodNumber"]} for e in chosen]
        out = solve_input(inp)
        self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertTrue({(e["assignmentId"], e["dayOfWeek"], e["periodNumber"]) for e in chosen} <= placed(out))
        self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])


class LockedObjectiveTest(unittest.TestCase):
    def test_a_lock_can_never_improve_the_optimal_objective(self):
        # both are solved to proven optimality: restricting the search space cannot make the optimum better
        tuples = [("a", "S1", "T1", 3), ("b", "S1", "T2", 2), ("c", "S2", "T1", 3)]
        inp = make_input(2, 4, all_continue(4), tuples, weights=weights_only("teacherRun3", 1), opts=options(timeLimitSeconds=30))
        free = solve_input(inp)
        self.assertEqual(free["status"], "OPTIMAL")
        locked = copy.deepcopy(inp)
        first = free["entries"][0]
        # lock a lesson into the WORST place for the objective we can find among the entries: another slot of the same assignment
        locked["fixedEntries"] = [{"assignmentId": first["assignmentId"], "dayOfWeek": "TUESDAY", "periodNumber": 4}]
        out = solve_input(locked)
        self.assertEqual(out["status"], "OPTIMAL")
        self.assertGreaterEqual(out["diagnostics"]["objectiveValue"], free["diagnostics"]["objectiveValue"])

    def test_locking_the_optimal_timetable_itself_keeps_the_optimum(self):
        tuples = [("a", "S1", "T1", 3), ("b", "S1", "T2", 2), ("c", "S2", "T1", 3)]
        inp = make_input(2, 4, all_continue(4), tuples, weights=weights_only("sectionHoles", 1), opts=options(timeLimitSeconds=30))
        free = solve_input(inp)
        locked = copy.deepcopy(inp)
        locked["fixedEntries"] = [{"assignmentId": e["assignmentId"], "dayOfWeek": e["dayOfWeek"], "periodNumber": e["periodNumber"]} for e in free["entries"]]
        out = solve_input(locked)
        self.assertEqual(out["status"], "OPTIMAL")
        self.assertEqual(out["diagnostics"]["objectiveValue"], free["diagnostics"]["objectiveValue"])
        self.assertEqual(placed(out), placed(free))


class DeterminismTest(unittest.TestCase):
    def test_the_order_of_the_fixed_entries_does_not_change_the_result(self):
        base = small_problem(opts=options(timeLimitSeconds=30, reproducible=True, deterministicTimeLimit=12.0, numWorkers=1))
        free = solve_input(base)
        chosen = [{"assignmentId": e["assignmentId"], "dayOfWeek": e["dayOfWeek"], "periodNumber": e["periodNumber"]} for e in free["entries"][::6]]
        a = copy.deepcopy(base)
        a["fixedEntries"] = list(chosen)
        b = copy.deepcopy(base)
        b["fixedEntries"] = list(reversed(chosen))
        out_a = solve_input(a)
        out_b = solve_input(b)
        self.assertEqual(out_a["status"], out_b["status"])
        self.assertEqual(sorted(out_a["entries"], key=lambda e: (e["assignmentId"], e["dayOfWeek"], e["periodNumber"])),
                         sorted(out_b["entries"], key=lambda e: (e["assignmentId"], e["dayOfWeek"], e["periodNumber"])))
        self.assertEqual(out_a["diagnostics"]["objectiveValue"], out_b["diagnostics"]["objectiveValue"])


class InfeasibleOnlyBecauseOfLocksTest(unittest.TestCase):
    """The same fixture the TypeScript lock-aware baseline test uses: T1 teaches 20 lessons in Y and 10 in X (30 = its capacity)."""

    def problem(self, extra_lock):
        tuples = [("xA", "X", "T1", 10), ("xB", "X", "T2", 10), ("xC", "X", "T3", 10), ("yD", "Y", "T1", 20)]
        slots = [(d, k) for d in range(4) for k in range(1, 7)][:20]
        fixed = [("yD", d, k) for d, k in slots]
        if extra_lock:
            fixed.append(("xB", 4, 1))
        return make_input(5, 6, all_continue(6), tuples, fixed=fixed, opts=options(timeLimitSeconds=30))

    def test_without_the_extra_lock_it_is_feasible(self):
        inp = self.problem(False)
        out = solve_input(inp)
        self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(canonical.hard_problems(inp, out["entries"]), [])

    def test_with_the_extra_lock_cp_sat_PROVES_it_infeasible(self):
        out = solve_input(self.problem(True))
        validate_output(out)
        self.assertEqual((out["status"], out["entries"]), ("INFEASIBLE", []))
        self.assertEqual(out["diagnostics"]["stoppedBy"], "INFEASIBLE")


class CommandLineTest(unittest.TestCase):
    def test_a_partial_lock_set_through_the_real_process(self):
        base = small_problem(opts=options(timeLimitSeconds=30))
        free = solve_input(base)
        chosen = free["entries"][:5]
        inp = copy.deepcopy(base)
        inp["fixedEntries"] = [{"assignmentId": e["assignmentId"], "dayOfWeek": e["dayOfWeek"], "periodNumber": e["periodNumber"]} for e in chosen]
        code, out, err = run_cli(inp)
        self.assertEqual(code, 0, err)
        self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertTrue({(e["assignmentId"], e["dayOfWeek"], e["periodNumber"]) for e in chosen} <= placed(out))

    def test_malformed_fixed_entries_are_rejected_not_silently_dropped(self):
        base = small_problem()
        for bad in (
            [{"assignmentId": "ghost", "dayOfWeek": "MONDAY", "periodNumber": 1}],
            [{"assignmentId": "m1", "dayOfWeek": "SATURDAY", "periodNumber": 1}],
            [{"assignmentId": "m1", "dayOfWeek": "MONDAY", "periodNumber": 7}],
            [{"assignmentId": "m1", "dayOfWeek": "MONDAY", "periodNumber": 1}, {"assignmentId": "m1", "dayOfWeek": "MONDAY", "periodNumber": 1}],
            [{"assignmentId": "m1", "dayOfWeek": "MONDAY", "periodNumber": 1, "teacherId": "TM"}],
        ):
            inp = copy.deepcopy(base)
            inp["fixedEntries"] = bad
            code, out, _err = run_cli(inp)
            self.assertEqual((code, out["status"], out["entries"]), (0, "INPUT_INVALID", []), f"{bad}")


if __name__ == "__main__":
    unittest.main()
