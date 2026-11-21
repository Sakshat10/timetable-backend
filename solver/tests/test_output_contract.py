"""Output contract: every output the solver can produce conforms to the Phase 1 solverOutputSchema, and an invalid
document is refused before it can be printed. (tests/test_cli.py and test-solver-contract.ts check the same
documents against the real Zod schema through the CLI.)"""
import copy
import math
import unittest

from timetable_solver.contract import ContractError, validate_output
from timetable_solver.solve import build_output, input_invalid_output
from tests.helpers import all_continue, make_input, options, solve_input

ENTRY = {"assignmentId": "a", "sectionId": "S", "subjectId": "x", "teacherId": "T", "dayOfWeek": "MONDAY", "periodNumber": 1}


def good(status="OPTIMAL", entries=None):
    return build_output(
        "req-1", status, [dict(ENTRY)] if entries is None and status in ("OPTIMAL", "FEASIBLE") else (entries or []),
        wall_seconds=1.5, options=None, stopped_by="NONE", messages=["ok"], objective_value=3.0, best_bound=1.0,
        num_booleans=10, num_constraints=5, conflicts=0, branches=0,
    )


def rejects(testcase, mutate, expect=None):
    out = good()
    mutate(out)
    with testcase.assertRaises(ContractError) as ctx:
        validate_output(out)
    if expect:
        testcase.assertTrue(any(expect in m for m in ctx.exception.messages), ctx.exception.messages)


class RealOutputsConformTest(unittest.TestCase):
    def test_every_status_the_solver_can_produce_conforms(self):
        outputs = {
            "OPTIMAL": solve_input(make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=10))),
            "INFEASIBLE": solve_input(make_input(1, 2, all_continue(2), [("a", "S", "T", 3)])),
            "UNKNOWN": solve_input(make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=5, reproducible=True, deterministicTimeLimit=0.001))),
        }
        for status, out in outputs.items():
            validate_output(out)
            self.assertEqual(out["status"], status if status != "UNKNOWN" else out["status"])
        invalid = input_invalid_output("req-1", ["bad"], 0.2)
        validate_output(invalid)
        self.assertEqual(invalid["status"], "INPUT_INVALID")

    def test_the_output_has_exactly_the_contract_keys(self):
        out = solve_input(make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=10)))
        self.assertEqual(set(out), {"contractVersion", "requestId", "status", "entries", "diagnostics"})
        self.assertEqual(set(out["diagnostics"]), {
            "objectiveValue", "bestObjectiveBound", "wallSeconds", "numWorkers", "seed", "ortoolsVersion", "numBooleans",
            "numConstraints", "conflicts", "branches", "stoppedBy", "messages"})
        self.assertEqual(set(out["entries"][0]), {"assignmentId", "sectionId", "subjectId", "teacherId", "dayOfWeek", "periodNumber"})
        self.assertEqual((out["contractVersion"], out["requestId"]), ("1.0", "req-1"))

    def test_numbers_have_the_right_types(self):
        d = solve_input(make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=10)))["diagnostics"]
        for key in ("numWorkers", "seed", "numBooleans", "numConstraints", "conflicts", "branches"):
            self.assertIs(type(d[key]), int, key)
        for key in ("wallSeconds", "objectiveValue", "bestObjectiveBound"):
            self.assertIs(type(d[key]), float, key)
        self.assertEqual(d["ortoolsVersion"], "9.15.6755")


class ValidateOutputRejectsTest(unittest.TestCase):
    def test_a_good_document_passes(self):
        validate_output(good())
        validate_output(good("FEASIBLE"))
        validate_output(good("UNKNOWN"))
        validate_output(good("INFEASIBLE"))

    def test_not_an_object_or_missing_and_extra_keys(self):
        for bad in (None, [], "x", 5):
            with self.assertRaises(ContractError):
                validate_output(bad)
        for key in ("contractVersion", "requestId", "status", "entries", "diagnostics"):
            rejects(self, lambda o, k=key: o.pop(k), key)
        rejects(self, lambda o: o.__setitem__("extra", 1), "extra")

    def test_header_fields(self):
        rejects(self, lambda o: o.__setitem__("contractVersion", "2.0"), "contractVersion")
        rejects(self, lambda o: o.__setitem__("requestId", ""), "requestId")
        rejects(self, lambda o: o.__setitem__("requestId", 5), "requestId")
        rejects(self, lambda o: o.__setitem__("status", "DONE"), "status")

    def test_entries_must_match_the_status(self):
        for status in ("INFEASIBLE", "UNKNOWN", "MODEL_INVALID", "INPUT_INVALID"):
            rejects(self, lambda o, s=status: o.update(status=s), "must be empty")
        rejects(self, lambda o: o.update(entries=[]), "must not be empty")
        rejects(self, lambda o: o.update(status="FEASIBLE", entries=[]), "must not be empty")

    def test_entry_shape(self):
        rejects(self, lambda o: o["entries"][0].__setitem__("extra", 1), "extra")
        rejects(self, lambda o: o["entries"][0].pop("teacherId"), "teacherId")
        rejects(self, lambda o: o["entries"][0].__setitem__("periodNumber", "3"), "periodNumber")
        rejects(self, lambda o: o["entries"][0].__setitem__("periodNumber", 1.5), "periodNumber")
        rejects(self, lambda o: o["entries"][0].__setitem__("periodNumber", True), "periodNumber")
        rejects(self, lambda o: o["entries"][0].__setitem__("dayOfWeek", "FUNDAY"), "dayOfWeek")
        rejects(self, lambda o: o["entries"][0].__setitem__("sectionId", ""), "sectionId")
        rejects(self, lambda o: o["entries"][0].__setitem__("assignmentId", "x" * 101), "assignmentId")
        rejects(self, lambda o: o.update(entries=["a"]), "entries")

    def test_diagnostics(self):
        for key in ("objectiveValue", "bestObjectiveBound", "wallSeconds", "numWorkers", "seed", "ortoolsVersion", "numBooleans",
                    "numConstraints", "conflicts", "branches", "stoppedBy", "messages"):
            rejects(self, lambda o, k=key: o["diagnostics"].pop(k), key)
        rejects(self, lambda o: o["diagnostics"].__setitem__("extra", 1), "extra")
        rejects(self, lambda o: o["diagnostics"].__setitem__("stoppedBy", "SOON"), "stoppedBy")
        rejects(self, lambda o: o["diagnostics"].__setitem__("wallSeconds", -1), "wallSeconds")
        rejects(self, lambda o: o["diagnostics"].__setitem__("wallSeconds", math.nan), "wallSeconds")
        rejects(self, lambda o: o["diagnostics"].__setitem__("objectiveValue", "3"), "objectiveValue")
        rejects(self, lambda o: o["diagnostics"].__setitem__("objectiveValue", math.inf), "objectiveValue")
        rejects(self, lambda o: o["diagnostics"].__setitem__("numWorkers", -1), "numWorkers")
        rejects(self, lambda o: o["diagnostics"].__setitem__("branches", 1.5), "branches")
        rejects(self, lambda o: o["diagnostics"].__setitem__("conflicts", -3), "conflicts")
        rejects(self, lambda o: o["diagnostics"].__setitem__("messages", ["x"] * 51), "messages")
        rejects(self, lambda o: o["diagnostics"].__setitem__("messages", ["x" * 501]), "messages")
        rejects(self, lambda o: o["diagnostics"].__setitem__("messages", "text"), "messages")

    def test_nullable_diagnostics_are_accepted(self):
        out = good("UNKNOWN")
        for key in ("objectiveValue", "bestObjectiveBound", "numBooleans", "numConstraints", "conflicts", "branches"):
            out["diagnostics"][key] = None
        validate_output(out)


class BuildOutputTest(unittest.TestCase):
    def test_messages_are_clipped_to_the_contract_limits(self):
        out = build_output("r", "UNKNOWN", [], wall_seconds=0.1, options=None, stopped_by="NONE", messages=["m" * 900] * 80)
        self.assertEqual(len(out["diagnostics"]["messages"]), 50)
        self.assertTrue(all(len(m) <= 500 for m in out["diagnostics"]["messages"]))
        validate_output(out)

    def test_non_finite_numbers_become_null(self):
        out = build_output("r", "UNKNOWN", [], wall_seconds=0.1, options=None, stopped_by="NONE", messages=[], objective_value=math.inf, best_bound=-math.inf)
        self.assertEqual((out["diagnostics"]["objectiveValue"], out["diagnostics"]["bestObjectiveBound"]), (None, None))
        validate_output(out)

    def test_wall_time_is_never_negative_and_is_rounded(self):
        out = build_output("r", "UNKNOWN", [], wall_seconds=-5, options=None, stopped_by="NONE", messages=[])
        self.assertEqual(out["diagnostics"]["wallSeconds"], 0.0)
        out = build_output("r", "UNKNOWN", [], wall_seconds=1.23456, options=None, stopped_by="NONE", messages=[])
        self.assertEqual(out["diagnostics"]["wallSeconds"], 1.235)

    def test_input_invalid_output_has_no_entries_and_error_stop_reason(self):
        out = input_invalid_output("r", ["bad thing"], 0.3)
        self.assertEqual((out["status"], out["entries"], out["diagnostics"]["stoppedBy"]), ("INPUT_INVALID", [], "ERROR"))
        self.assertEqual((out["diagnostics"]["numWorkers"], out["diagnostics"]["seed"]), (0, 0))


if __name__ == "__main__":
    unittest.main()
