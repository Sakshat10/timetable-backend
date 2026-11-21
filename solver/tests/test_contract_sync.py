"""The TypeScript contract is the source of truth. These tests read it and fail if the Python constants drift."""
import re
import unittest

from timetable_solver import contract
from tests.helpers import TS_CONTRACTS, TS_DAYS, WEIGHTS_V1

TS = TS_CONTRACTS.read_text()


def ts_int(name: str) -> int:
    match = re.search(rf"const {name} = ([\d_]+);", TS)
    assert match, name
    return int(match.group(1).replace("_", ""))


def ts_string_list(text: str) -> list[str]:
    return re.findall(r"'([^']+)'", text)


class ContractSyncTest(unittest.TestCase):
    def test_contract_version(self):
        self.assertEqual(re.search(r"export const CONTRACT_VERSION = '([^']+)'", TS).group(1), contract.CONTRACT_VERSION)

    def test_weights_v1_matches_typescript(self):
        block = re.search(r"export const WEIGHTS_V1[^{]*\{(.*?)\}\)", TS, re.S).group(1)
        parsed = {name: int(value) for name, value in re.findall(r"(\w+):\s*(\d+)", block)}
        self.assertEqual(parsed, WEIGHTS_V1)
        self.assertEqual(parsed, {"teacherRun3": 3, "teacherRun4Plus": 8, "subjectSameDayExcess": 5, "sectionHoles": 4, "dailyLoadExcess": 2})

    def test_weights_version(self):
        self.assertEqual(re.search(r"export const WEIGHTS_VERSION = '([^']+)'", TS).group(1), "V1")

    def test_term_names(self):
        block = re.search(r"export const TERM_NAMES = \[(.*?)\] as const", TS, re.S).group(1)
        self.assertEqual(tuple(ts_string_list(block)), contract.TERM_NAMES)

    def test_solver_statuses(self):
        block = re.search(r"export const SOLVER_STATUSES = \[(.*?)\] as const", TS, re.S).group(1)
        self.assertEqual(tuple(ts_string_list(block)), contract.SOLVER_STATUSES)

    def test_stopped_by(self):
        block = re.search(r"stoppedBy: z\.enum\(\[(.*?)\]\)", TS, re.S).group(1)
        self.assertEqual(tuple(ts_string_list(block)), contract.STOPPED_BY)

    def test_days_of_week(self):
        block = re.search(r"export const DAYS_OF_WEEK = \[(.*?)\] as const", TS_DAYS.read_text(), re.S).group(1)
        self.assertEqual(tuple(ts_string_list(block)), contract.DAYS_OF_WEEK)

    def test_numeric_limits(self):
        self.assertEqual(ts_int("MAX_SECTIONS"), contract.MAX_SECTIONS)
        self.assertEqual(ts_int("MAX_TEACHERS"), contract.MAX_TEACHERS)
        self.assertEqual(ts_int("MAX_ASSIGNMENTS"), contract.MAX_ASSIGNMENTS)
        self.assertEqual(ts_int("MAX_ENTRIES"), contract.MAX_ENTRIES)
        self.assertEqual(ts_int("MAX_WORKERS"), contract.MAX_WORKERS)
        self.assertEqual(ts_int("MAX_TIME_LIMIT_CEILING"), contract.MAX_TIME_LIMIT_CEILING)

    def test_field_limits_in_the_schemas(self):
        self.assertIn("const id = z.string().min(1).max(100);", TS)
        self.assertEqual(contract.MAX_ID_LENGTH, 100)
        self.assertIn("seed: z.int().min(0).max(2_147_483_647)", TS)
        self.assertIn("numWorkers: z.int().min(1).max(MAX_WORKERS)", TS)
        self.assertIn("timeLimitSeconds: z.int().min(1).max(MAX_TIME_LIMIT_CEILING)", TS)
        self.assertIn(".min(1)\n    .max(12),\n  maxTeacherPeriodsPerWeek", TS)  # periods 1..12
        self.assertIn("periodsPerWeek: z.int().min(1).max(100)", TS)
        self.assertIn("weeklyCapacity: z.int().min(1).max(MAX_TEACHER_PERIODS_PER_WEEK)", TS)
        self.assertIn("z.int().min(0).max(1_000)", TS)  # weights
        self.assertIn("weightsVersion: z.string().min(1).max(20)", TS)
        self.assertIn("messages: z.array(z.string().max(500)).max(50)", TS)
        self.assertEqual((contract.MAX_MESSAGE_LENGTH, contract.MAX_MESSAGES), (500, 50))

    def test_max_teacher_periods_constant(self):
        schema = (TS_CONTRACTS.parent.parent / "timetable-feasibility" / "timetable-feasibility.schema.ts").read_text()
        self.assertEqual(int(re.search(r"MAX_TEACHER_PERIODS_PER_WEEK = (\d+)", schema).group(1)), contract.MAX_TEACHER_PERIODS_PER_WEEK)

    def test_every_strict_object_field_is_known_to_python(self):
        """Input and output keys declared in the schemas must be exactly the ones the Python validator expects."""
        input_top = re.search(r"export const solverInputSchema = z\.strictObject\(\{(.*?)\n\}\);", TS, re.S).group(1)
        ts_keys = tuple(re.findall(r"^  (\w+):", input_top, re.M))
        self.assertEqual(ts_keys, contract._TOP_KEYS)
        entry = re.search(r"export const timetableEntrySchema = z\.strictObject\(\{(.*?)\n\}\);", TS, re.S).group(1)
        self.assertEqual(tuple(re.findall(r"^  (\w+)", entry, re.M)), contract._ENTRY_KEYS)
        diag = re.search(r"export const solverDiagnosticsSchema = z\.strictObject\(\{(.*?)\n\}\);", TS, re.S).group(1)
        self.assertEqual(tuple(re.findall(r"^  (\w+):", diag, re.M)), contract._DIAGNOSTIC_KEYS)


if __name__ == "__main__":
    unittest.main()
