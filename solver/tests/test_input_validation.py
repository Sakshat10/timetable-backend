"""Strict input validation: malformed payloads, invalid ids, invalid grids. In-process via parse_problem()."""
import copy
import io
import json
import random
import unittest

from timetable_solver import cli
from timetable_solver.contract import ContractError, parse_problem, utf16_len, validate_output
from tests.helpers import all_continue, make_input, options


def base() -> dict:
    return make_input(5, 6, all_continue(6), [("a1", "S1", "T1", 5), ("a2", "S1", "T2", 4), ("a3", "S2", "T1", 3)])


def rejected(testcase: unittest.TestCase, mutate, expect: str | None = None) -> None:
    inp = base()
    mutate(inp)
    with testcase.assertRaises(ContractError) as ctx:
        parse_problem(inp)
    if expect is not None:
        testcase.assertTrue(any(expect in m for m in ctx.exception.messages), f"{expect!r} not in {ctx.exception.messages}")


def accepted(testcase: unittest.TestCase, mutate) -> None:
    inp = base()
    mutate(inp)
    parse_problem(inp)


class ValidPayloadTest(unittest.TestCase):
    def test_a_valid_payload_parses_into_a_typed_problem(self):
        p = parse_problem(base())
        self.assertEqual((p.days, p.periods_per_day, p.weekly_slots), (5, 6, 30))
        self.assertEqual([a.id for a in p.assignments], ["a1", "a2", "a3"])
        self.assertEqual(p.sections, ("S1", "S2"))
        self.assertEqual([t for t, _ in p.teachers], ["T1", "T2"])
        self.assertEqual(p.continues, (True, True, True, True, True, False))

    def test_the_last_period_flag_is_ignored(self):
        inp = base()
        inp["grid"]["periods"][-1]["continuesIntoNext"] = True
        self.assertFalse(parse_problem(inp).continues[-1])

    def test_input_order_does_not_matter(self):
        a = base()
        b = copy.deepcopy(a)
        rnd = random.Random(3)
        for key in ("sections", "teachers", "assignments"):
            rnd.shuffle(b[key])
        self.assertEqual(parse_problem(a), parse_problem(b))

    def test_integral_floats_count_as_integers_like_json_numbers_in_javascript(self):
        def mutate(inp):
            inp["options"]["timeLimitSeconds"] = 30.0
            inp["assignments"][0]["periodsPerWeek"] = 5.0
        accepted(self, mutate)

    def test_ids_are_measured_in_utf16_units_like_zod(self):
        self.assertEqual(utf16_len("a"), 1)
        self.assertEqual(utf16_len("😀"), 2)
        accepted(self, lambda i: i["sections"].append({"id": "😀" * 50}))   # 100 UTF-16 units: allowed
        rejected(self, lambda i: i["sections"].append({"id": "😀" * 51}), "length")  # 102 units: rejected, as Zod does

    def test_a_max_length_id_is_accepted_and_one_more_is_not(self):
        accepted(self, lambda i: i.__setitem__("requestId", "r" * 100))
        rejected(self, lambda i: i.__setitem__("requestId", "r" * 101), "requestId")


class MalformedPayloadTest(unittest.TestCase):
    def test_not_an_object(self):
        for raw in ([], "x", None, 5, True, [1, 2]):
            with self.assertRaises(ContractError):
                parse_problem(raw)

    def test_every_top_level_key_is_required(self):
        for key in base():
            rejected(self, lambda i, key=key: i.pop(key), key)

    def test_unknown_top_level_key(self):
        rejected(self, lambda i: i.__setitem__("debug", True), "debug")

    def test_contract_version(self):
        rejected(self, lambda i: i.__setitem__("contractVersion", "2.0"), "contractVersion")
        rejected(self, lambda i: i.__setitem__("contractVersion", 1), "contractVersion")

    def test_weights(self):
        rejected(self, lambda i: i["weights"].pop("sectionHoles"), "sectionHoles")
        rejected(self, lambda i: i["weights"].__setitem__("extra", 1), "extra")
        rejected(self, lambda i: i["weights"].__setitem__("teacherRun3", -1), "teacherRun3")
        rejected(self, lambda i: i["weights"].__setitem__("teacherRun3", 1001), "teacherRun3")
        rejected(self, lambda i: i["weights"].__setitem__("teacherRun3", 1.5), "teacherRun3")
        rejected(self, lambda i: i["weights"].__setitem__("teacherRun3", True), "teacherRun3")
        rejected(self, lambda i: i.__setitem__("weightsVersion", ""), "weightsVersion")
        rejected(self, lambda i: i.__setitem__("weightsVersion", "v" * 21), "weightsVersion")

    def test_options(self):
        for field, bad in [
            ("seed", -1), ("seed", 2**31), ("seed", 1.5), ("seed", True), ("seed", "1"),
            ("numWorkers", 0), ("numWorkers", 65), ("numWorkers", 2.5), ("numWorkers", None),
            ("timeLimitSeconds", 0), ("timeLimitSeconds", 3601), ("timeLimitSeconds", "30"), ("timeLimitSeconds", False),
            ("reproducible", "yes"), ("reproducible", 1), ("reproducible", None),
        ]:
            rejected(self, lambda i, f=field, b=bad: i["options"].__setitem__(f, b), field)

    def test_options_keys(self):
        rejected(self, lambda i: i["options"].pop("seed"), "seed")
        rejected(self, lambda i: i["options"].__setitem__("extra", 1), "extra")
        rejected(self, lambda i: i.__setitem__("options", []), "options")

    def test_deterministic_time_limit_rules(self):
        accepted(self, lambda i: i["options"].update(reproducible=True, deterministicTimeLimit=12.5))
        for bad in (0, -1, 3601, "x", float("nan"), float("inf"), True):
            rejected(self, lambda i, b=bad: i["options"].update(reproducible=True, deterministicTimeLimit=b), "deterministicTimeLimit")
        rejected(self, lambda i: i["options"].update(reproducible=True, deterministicTimeLimit=None), "required when reproducible")
        rejected(self, lambda i: i["options"].update(reproducible=False, deterministicTimeLimit=5), "must be null when reproducible")

    def test_error_report_is_capped(self):
        inp = base()
        inp["assignments"] = [{"id": f"x{i}", "sectionId": "nope", "subjectId": "s", "subjectRequirementId": f"r{i}", "teacherId": "nope", "periodsPerWeek": 1} for i in range(100)]
        with self.assertRaises(ContractError) as ctx:
            parse_problem(inp)
        self.assertLessEqual(len(ctx.exception.messages), 21)
        self.assertIn("more errors omitted", ctx.exception.messages[-1])


class InvalidIdTest(unittest.TestCase):
    def test_assignment_references(self):
        rejected(self, lambda i: i["assignments"][0].__setitem__("sectionId", "ghost"), "unknown section")
        rejected(self, lambda i: i["assignments"][0].__setitem__("teacherId", "ghost"), "unknown teacher")

    def test_duplicates(self):
        rejected(self, lambda i: i["sections"].append({"id": "S1"}), "duplicate section")
        rejected(self, lambda i: i["teachers"].append({"id": "T1", "weeklyCapacity": 30}), "duplicate teacher")
        rejected(self, lambda i: i["assignments"][1].__setitem__("id", "a1"), "duplicate assignment id")
        rejected(self, lambda i: i["assignments"][1].update(sectionId="S1", subjectRequirementId=i["assignments"][0]["subjectRequirementId"]), "only one assignment")

    def test_id_shape(self):
        for key in ("id", "sectionId", "subjectId", "subjectRequirementId", "teacherId"):
            for bad in ("", "x" * 101, 5, None, ["a"]):
                rejected(self, lambda i, k=key, b=bad: i["assignments"][0].__setitem__(k, b), key)
        rejected(self, lambda i: i["sections"][0].__setitem__("id", ""), "sections")
        rejected(self, lambda i: i["teachers"][0].__setitem__("id", 7), "teachers")

    def test_period_counts(self):
        for bad in (0, -1, 101, 2.5, "3", None, True):
            rejected(self, lambda i, b=bad: i["assignments"][0].__setitem__("periodsPerWeek", b), "periodsPerWeek")

    def test_assignment_and_entity_shape(self):
        rejected(self, lambda i: i["assignments"][0].pop("teacherId"), "teacherId")
        rejected(self, lambda i: i["assignments"][0].__setitem__("gradeId", "g8"), "gradeId")
        rejected(self, lambda i: i["assignments"][0].__setitem__("streamId", "SCI"), "streamId")
        rejected(self, lambda i: i["sections"][0].__setitem__("streamId", "SCI"), "streamId")
        rejected(self, lambda i: i["sections"][0].__setitem__("gradeId", "g8"), "gradeId")
        rejected(self, lambda i: i["teachers"][0].__setitem__("name", "Asha"), "name")
        rejected(self, lambda i: i["assignments"].__setitem__(0, "a1"), "assignments")

    def test_lists_must_not_be_empty(self):
        for key in ("sections", "teachers", "assignments"):
            rejected(self, lambda i, k=key: i.__setitem__(k, []), key)
        accepted(self, lambda i: i.__setitem__("fixedEntries", []))

    def test_teacher_capacity_range(self):
        for bad in (0, 33, -1, 2.5, "30"):
            rejected(self, lambda i, b=bad: i["teachers"][0].__setitem__("weeklyCapacity", b), "weeklyCapacity")


class InvalidGridTest(unittest.TestCase):
    def test_days(self):
        rejected(self, lambda i: i["grid"].__setitem__("days", []), "days")
        rejected(self, lambda i: i["grid"].__setitem__("days", [{"index": n, "dayOfWeek": "MONDAY"} for n in range(8)]), "days")
        rejected(self, lambda i: i["grid"]["days"][1].__setitem__("index", 3), "position")
        rejected(self, lambda i: i["grid"]["days"][1].__setitem__("dayOfWeek", "MONDAY"), "duplicate working day")
        rejected(self, lambda i: i["grid"]["days"][1].__setitem__("dayOfWeek", "FUNDAY"), "dayOfWeek")
        rejected(self, lambda i: i["grid"]["days"][1].__setitem__("index", 7), "index")
        rejected(self, lambda i: i["grid"]["days"][1].pop("index"), "index")
        rejected(self, lambda i: i["grid"]["days"][1].__setitem__("label", "x"), "label")

    def test_periods(self):
        rejected(self, lambda i: i["grid"].__setitem__("periods", []), "periods")
        rejected(self, lambda i: i["grid"].__setitem__("periods", [{"periodNumber": n + 1, "continuesIntoNext": True} for n in range(13)]), "periods")
        rejected(self, lambda i: i["grid"]["periods"][2].__setitem__("periodNumber", 4), "must be 3")
        rejected(self, lambda i: i["grid"]["periods"][0].__setitem__("periodNumber", 0), "periodNumber")
        rejected(self, lambda i: i["grid"]["periods"][0].__setitem__("periodNumber", 2), "must be 1")
        rejected(self, lambda i: i["grid"]["periods"][1].__setitem__("continuesIntoNext", "yes"), "continuesIntoNext")
        rejected(self, lambda i: i["grid"]["periods"][1].pop("continuesIntoNext"), "continuesIntoNext")
        rejected(self, lambda i: i["grid"]["periods"][1].__setitem__("start", "08:00"), "start")

    def test_grid_shape_and_limits(self):
        for bad in (0, 33, -2, 3.5, "32", None):
            rejected(self, lambda i, b=bad: i["grid"].__setitem__("maxTeacherPeriodsPerWeek", b), "maxTeacherPeriodsPerWeek")
        rejected(self, lambda i: i["grid"].pop("days"), "days")
        rejected(self, lambda i: i["grid"].__setitem__("timezone", "UTC"), "timezone")
        rejected(self, lambda i: i.__setitem__("grid", None), "grid")

    def test_all_grid_sizes_the_contract_allows_are_accepted(self):
        for D in range(1, 8):
            for K in (1, 6, 12):
                parse_problem(make_input(D, K, all_continue(K), [("a", "S", "T", 1)]))


class FixedEntryValidationTest(unittest.TestCase):
    def fixed(self, **over):
        entry = {"assignmentId": "a1", "dayOfWeek": "MONDAY", "periodNumber": 1}
        entry.update(over)
        return entry

    def test_valid_fixed_entry_is_resolved_to_indexes(self):
        inp = base()
        inp["fixedEntries"] = [self.fixed(dayOfWeek="TUESDAY", periodNumber=3)]
        p = parse_problem(inp)
        self.assertEqual(p.fixed, ((0, 1, 2),))

    def test_rejections(self):
        for entry, expect in [
            (self.fixed(assignmentId="ghost"), "unknown assignment"),
            (self.fixed(dayOfWeek="SATURDAY"), "not a working day"),
            (self.fixed(dayOfWeek="FUNDAY"), "not a day"),
            (self.fixed(periodNumber=0), "periodNumber"),
            (self.fixed(periodNumber=7), "outside the grid"),
            (self.fixed(periodNumber=1.5), "periodNumber"),
            ({"assignmentId": "a1", "dayOfWeek": "MONDAY"}, "periodNumber"),
            (self.fixed(extra=1), "extra"),
        ]:
            inp = base()
            inp["fixedEntries"] = [entry]
            with self.assertRaises(ContractError) as ctx:
                parse_problem(inp)
            self.assertTrue(any(expect in m for m in ctx.exception.messages), (entry, ctx.exception.messages))

    def test_duplicate_fixed_entry(self):
        inp = base()
        inp["fixedEntries"] = [self.fixed(), self.fixed()]
        with self.assertRaises(ContractError):
            parse_problem(inp)

    def test_fixedEntries_must_be_a_list(self):
        rejected(self, lambda i: i.__setitem__("fixedEntries", {}), "fixedEntries")


class InputInvalidOutputTest(unittest.TestCase):
    """A rejected payload that still has a usable requestId is answered with an INPUT_INVALID contract output."""

    def run_cli(self, payload):
        stdout, stderr = io.BytesIO(), io.StringIO()
        code = cli.run(json.dumps(payload).encode(), process_start=0.0, stdout=stdout, stderr=stderr, clock=lambda: 0.5)
        return code, (json.loads(stdout.getvalue()) if stdout.getvalue() else None), stderr.getvalue()

    def test_invalid_payload_with_request_id(self):
        inp = base()
        inp["assignments"][0]["teacherId"] = "ghost"
        code, out, _ = self.run_cli(inp)
        self.assertEqual(code, 0)
        self.assertEqual(out["status"], "INPUT_INVALID")
        self.assertEqual(out["requestId"], "req-1")
        self.assertEqual(out["entries"], [])
        self.assertEqual(out["diagnostics"]["stoppedBy"], "ERROR")
        self.assertTrue(any("unknown teacher" in m for m in out["diagnostics"]["messages"]))
        validate_output(out)

    def test_every_rejection_produces_a_conforming_document(self):
        inp = base()
        inp["options"]["seed"] = -5
        inp["grid"]["days"] = []
        inp["extra"] = 1
        code, out, _ = self.run_cli(inp)
        self.assertEqual((code, out["status"]), (0, "INPUT_INVALID"))
        validate_output(out)


if __name__ == "__main__":
    unittest.main()
