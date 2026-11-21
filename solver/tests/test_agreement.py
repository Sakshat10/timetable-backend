"""Weighted-objective agreement between the CP-SAT objective and the independent canonical evaluator.

  OPTIMAL  -> the solver's objective equals the canonical weighted objective of the returned entries, exactly.
  FEASIBLE -> the solver's objective is >= the canonical objective (soft variables are one-sided, so an
              unconverged solution can carry slack); the canonical value computed from the entries is the truth.
"""
import random
import unittest

from tests import canonical
from tests.helpers import TERMS, WEIGHTS_V1, all_continue, golden_cases, golden_input, make_input, options, solve_input


def random_instance(rnd: random.Random):
    D = rnd.choice((2, 3))
    K = rnd.choice((3, 4, 5))
    W = D * K
    n_sections, n_teachers = rnd.randint(2, 4), rnd.randint(2, 4)
    cap = min(32, W)
    teacher_load = [0] * n_teachers
    section_demand = [0] * n_sections
    tuples = []
    for i in range(rnd.randint(3, 9)):
        s, t, p = rnd.randrange(n_sections), rnd.randrange(n_teachers), rnd.randint(1, 4)
        if teacher_load[t] + p > cap or section_demand[s] + p > W:
            continue
        teacher_load[t] += p
        section_demand[s] += p
        tuples.append((f"a{i}", f"S{s}", f"T{t}", p))
    if not tuples:
        tuples = [("a0", "S0", "T0", 1)]
    continues = [rnd.random() < 0.75 for _ in range(K)]
    continues[-1] = False
    weights = {name: rnd.choice((0, 1, 2, 3, 5, 8, 10)) for name in TERMS}
    return make_input(D, K, continues, tuples, weights=weights, opts=options(timeLimitSeconds=20, numWorkers=2, seed=rnd.randint(0, 999)))


class RandomAgreementTest(unittest.TestCase):
    def test_40_random_small_instances_with_random_weights_and_breaks(self):
        rnd = random.Random(2026)
        optimal = 0
        total = 40
        for n in range(total):
            inp = random_instance(rnd)
            out = solve_input(inp)
            self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"), f"instance {n}")
            entries = out["entries"]
            self.assertEqual(canonical.hard_problems(inp, entries), [], f"instance {n}")
            truth = canonical.evaluate(inp, entries)["weighted"]
            objective = out["diagnostics"]["objectiveValue"]
            if out["status"] == "OPTIMAL":
                optimal += 1
                self.assertEqual(objective, truth, f"instance {n}: objective {objective} != canonical {truth}")
            else:
                self.assertGreaterEqual(objective, truth, f"instance {n}")
        self.assertGreaterEqual(optimal, int(total * 0.9), f"only {optimal}/{total} instances were solved to optimality; the test would be vacuous")

    def test_optimality_is_a_true_minimum_not_just_a_valid_value(self):
        """On a tiny instance, enumerate the canonical objective of EVERY valid timetable and compare the minimum."""
        import itertools
        tuples = [("a", "S", "T1", 2), ("b", "S", "T2", 2), ("c", "S2", "T1", 1)]
        D, K = 2, 3
        inp = make_input(D, K, [True, False, False], tuples, weights=WEIGHTS_V1, opts=options(timeLimitSeconds=20, numWorkers=1))
        slots = [(d, k) for d in range(D) for k in range(1, K + 1)]
        best = None
        from tests.helpers import entry_for
        for a_slots in itertools.combinations(slots, 2):
            for b_slots in itertools.combinations(slots, 2):
                if set(a_slots) & set(b_slots):
                    continue  # same section S
                for c_slot in slots:
                    if c_slot in a_slots:
                        continue  # same teacher T1
                    entries = [entry_for(inp, "a", d, k) for d, k in a_slots] + [entry_for(inp, "b", d, k) for d, k in b_slots] + [entry_for(inp, "c", *c_slot)]
                    value = canonical.evaluate(inp, entries)["weighted"]
                    best = value if best is None else min(best, value)
        out = solve_input(inp)
        self.assertEqual(out["status"], "OPTIMAL")
        self.assertEqual(out["diagnostics"]["objectiveValue"], best)
        self.assertEqual(canonical.evaluate(inp, out["entries"])["weighted"], best)


class GoldenAgreementTest(unittest.TestCase):
    def test_optimal_solve_of_a_golden_10_section_school_agrees_exactly(self):
        case = next(c for c in golden_cases() if c["name"].startswith("s10_5d6p"))
        inp = golden_input(case, opts=options(timeLimitSeconds=60, numWorkers=4))
        out = solve_input(inp)
        self.assertEqual(out["status"], "OPTIMAL")
        self.assertEqual(out["diagnostics"]["objectiveValue"], canonical.evaluate(inp, out["entries"])["weighted"])

    def test_feasible_solve_of_a_golden_50_section_school_never_undercounts(self):
        case = next(c for c in golden_cases() if c["name"].startswith("s50_5d7p"))
        inp = golden_input(case, opts=options(timeLimitSeconds=8, numWorkers=4))
        out = solve_input(inp)
        self.assertIn(out["status"], ("OPTIMAL", "FEASIBLE"))
        truth = canonical.evaluate(inp, out["entries"])["weighted"]
        slack = out["diagnostics"]["objectiveValue"] - truth
        self.assertGreaterEqual(slack, 0, "the solver objective must never be below the canonical value")
        # report the observed slack so a regression in model tightness is visible in the log
        print(f"\n  [50-section FEASIBLE] solver objective {out['diagnostics']['objectiveValue']}, canonical {truth}, slack {slack}")

    def test_the_solver_objective_is_diagnostic_only_and_may_exceed_the_truth(self):
        """Documented behaviour: the authoritative metric is recomputed from the entries by the backend."""
        inp = make_input(5, 6, all_continue(6), [(f"a{i}", f"S{i % 3}", f"T{i % 4}", 4) for i in range(8)], opts=options(timeLimitSeconds=3, numWorkers=1))
        out = solve_input(inp)
        truth = canonical.evaluate(inp, out["entries"])["weighted"]
        self.assertGreaterEqual(out["diagnostics"]["objectiveValue"], truth)


if __name__ == "__main__":
    unittest.main()
