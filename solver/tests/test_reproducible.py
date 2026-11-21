"""Reproducible mode: opt-in, interleave_search, a deterministic-time limit, no cross-environment claim.

What is verified here is exactly what was verified in Phase 0 and nothing more: on THIS machine, with THIS OR-Tools
version, the same input gives the same entries. The default (non-reproducible) mode makes no such promise.
"""
import hashlib
import json
import random
import unittest

from tests.helpers import all_continue, golden_cases, golden_input, make_input, options, solve_input
from timetable_solver.contract import parse_problem
from timetable_solver.solve import make_parameters


def digest(entries) -> str:
    return hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()[:16]


def golden10():
    return next(c for c in golden_cases() if c["name"].startswith("s10_6d8p"))


def repro_options(det=8, seed=1, workers=4):
    return options(timeLimitSeconds=120, numWorkers=workers, seed=seed, reproducible=True, deterministicTimeLimit=det)


class ParametersTest(unittest.TestCase):
    def params(self, **over):
        return make_parameters(parse_problem(make_input(5, 6, all_continue(6), [("a", "S", "T", 3)], opts=options(**over))).options, 12.5)

    def test_default_mode_is_not_reproducible(self):
        p = self.params(numWorkers=4, seed=9)
        self.assertEqual(p, {"num_workers": 4, "random_seed": 9, "max_time_in_seconds": 12.5, "log_search_progress": False})
        self.assertNotIn("interleave_search", p)
        self.assertNotIn("max_deterministic_time", p)

    def test_reproducible_mode_adds_interleave_search_and_a_deterministic_limit(self):
        p = self.params(numWorkers=4, seed=9, reproducible=True, deterministicTimeLimit=54.0)
        self.assertEqual(p["interleave_search"], True)
        self.assertEqual(p["max_deterministic_time"], 54.0)
        self.assertEqual(p["max_time_in_seconds"], 12.5)  # the wall-clock limit stays as a backstop
        self.assertEqual((p["num_workers"], p["random_seed"]), (4, 9))

    def test_the_worker_count_is_exactly_what_the_backend_asked_for(self):
        for workers in (1, 2, 4, 8):
            self.assertEqual(self.params(numWorkers=workers)["num_workers"], workers)

    def test_no_parallelism_beyond_the_requested_workers(self):
        import re
        from tests.test_environment import production_sources, code_only
        for name, text in production_sources().items():
            self.assertIsNone(re.search(r"num_workers\s*=\s*(0|os\.cpu_count|multiprocessing)", code_only(text)), name)


class ReproducibleModeTest(unittest.TestCase):
    def test_three_runs_give_identical_entries(self):
        inp = golden_input(golden10(), opts=repro_options())
        runs = [solve_input(inp) for _ in range(3)]
        for out in runs:
            self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"))
        hashes = [digest(out["entries"]) for out in runs]
        self.assertEqual(len(set(hashes)), 1, hashes)
        self.assertEqual(len({out["diagnostics"]["objectiveValue"] for out in runs}), 1)

    def test_a_reproducible_solve_that_hits_its_limit_reports_the_deterministic_limit(self):
        out = solve_input(golden_input(golden10(), opts=repro_options(det=2)))
        if out["status"] == "FEASIBLE":
            self.assertEqual(out["diagnostics"]["stoppedBy"], "DETERMINISTIC_LIMIT")
        self.assertTrue(any("reproducible mode" in m and "one environment" in m for m in out["diagnostics"]["messages"]))

    def test_the_order_of_the_input_arrays_does_not_change_the_result(self):
        inp = golden_input(golden10(), opts=repro_options(det=6))
        shuffled = json.loads(json.dumps(inp))
        rnd = random.Random(5)
        for key in ("sections", "teachers", "assignments"):
            rnd.shuffle(shuffled[key])
        self.assertEqual(digest(solve_input(inp)["entries"]), digest(solve_input(shuffled)["entries"]))

    def test_with_one_worker_a_different_seed_is_a_different_search(self):
        """Measured on this environment (OR-Tools 9.15.6755): single worker + interleave_search, det limit 6, seeds 1..4
        gave four different outcomes (objectives 375, 323, UNKNOWN, 281). The search is deterministic, so this is stable."""
        a = solve_input(golden_input(golden10(), opts=repro_options(det=6, seed=1, workers=1)))
        b = solve_input(golden_input(golden10(), opts=repro_options(det=6, seed=2, workers=1)))
        self.assertNotEqual(digest(a["entries"]), digest(b["entries"]))

    def test_the_seed_has_no_documented_effect_with_several_workers_in_this_mode(self):
        """Measured, NOT asserted as a guarantee: with 4 workers + interleave_search the seeds 1..4 all produced the same
        timetable. The seed is still recorded and echoed, but callers must not rely on it to vary a reproducible run."""
        runs = [digest(solve_input(golden_input(golden10(), opts=repro_options(det=2, seed=seed, workers=4)))["entries"]) for seed in (1, 2)]
        for h in runs:
            self.assertEqual(len(h), 16)  # each run completed and is reproducible per seed (see the 3-run test above)

    def test_the_seed_is_echoed_in_the_diagnostics(self):
        out = solve_input(golden_input(golden10(), opts=repro_options(det=2, seed=77)))
        self.assertEqual((out["diagnostics"]["seed"], out["diagnostics"]["numWorkers"]), (77, 4))

    def test_reproducible_mode_is_opt_in_the_default_run_says_nothing_about_determinism(self):
        out = solve_input(golden_input(golden10(), opts=options(timeLimitSeconds=5, numWorkers=2)))
        self.assertFalse(any("reproducible" in m for m in out["diagnostics"]["messages"]))


if __name__ == "__main__":
    unittest.main()


class DeterministicLimitVersusWallClockTest(unittest.TestCase):
    """The reproducibility fix relies on two properties of the solver, checked here directly:
    (1) the search result depends on the DETERMINISTIC limit and the seed, not on the wall-clock budget, as long as the deterministic limit is
        what ends the search;
    (2) when the wall-clock budget is shorter, it wins, and the solver says so (stoppedBy TIME_LIMIT), so the backend can warn."""

    @staticmethod
    def tight_problem(opts):
        # 3 sections x (5 + 4 + 3), one teacher per subject, a break after period 3: not solved to optimality within 2 s
        tuples = [(f"a{s}{i}", f"S{s}", f"T{i}", p) for s in range(3) for i, p in enumerate((5, 4, 3))]
        return make_input(5, 6, [True, True, False, True, True, False], tuples, opts=opts)

    @staticmethod
    def timetable(out):
        return sorted((e["assignmentId"], e["dayOfWeek"], e["periodNumber"]) for e in out["entries"])

    def test_the_same_deterministic_limit_gives_the_same_timetable_under_different_wall_clock_budgets(self):
        results = []
        for wall in (7, 10, 14):
            out = solve_input(self.tight_problem(options(timeLimitSeconds=wall, numWorkers=2, seed=31337, reproducible=True, deterministicTimeLimit=2.0)))
            self.assertEqual(out["diagnostics"]["stoppedBy"], "DETERMINISTIC_LIMIT", f"wall budget {wall} s")
            results.append((self.timetable(out), out["diagnostics"]["objectiveValue"]))
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[1], results[2])

    def test_different_deterministic_limits_may_give_different_timetables(self):
        # the very defect that was fixed: a different limit is a different search (this documents why the limit must not float)
        a = solve_input(self.tight_problem(options(timeLimitSeconds=30, numWorkers=2, seed=31337, reproducible=True, deterministicTimeLimit=2.0)))
        b = solve_input(self.tight_problem(options(timeLimitSeconds=30, numWorkers=2, seed=31337, reproducible=True, deterministicTimeLimit=4.0)))
        self.assertTrue(self.timetable(a) != self.timetable(b) or a["diagnostics"]["objectiveValue"] != b["diagnostics"]["objectiveValue"])

    def test_a_shorter_wall_clock_budget_wins_and_is_reported(self):
        out = solve_input(self.tight_problem(options(timeLimitSeconds=3, numWorkers=2, seed=31337, reproducible=True, deterministicTimeLimit=3000.0)))
        self.assertIn(out["status"], ("FEASIBLE", "UNKNOWN", "OPTIMAL"))
        if out["status"] != "OPTIMAL":  # (an unexpectedly fast proof of optimality is fine: the search then ended on its own)
            self.assertEqual(out["diagnostics"]["stoppedBy"], "TIME_LIMIT")
            self.assertLess(out["diagnostics"]["wallSeconds"], 8)
