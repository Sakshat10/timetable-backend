"""Pins and the architectural prohibitions: pinned versions, no hints, no database, no extra processes."""
import re
import sys
import unittest

import ortools

from timetable_solver.contract import parse_problem
from timetable_solver.model import build_model
from tests.helpers import SOLVER_DIR, all_continue, golden_cases, golden_input, make_input

PACKAGE = SOLVER_DIR / "timetable_solver"


def production_sources() -> dict[str, str]:
    files = {p.name: p.read_text() for p in PACKAGE.glob("*.py")}
    files["main.py"] = (SOLVER_DIR / "main.py").read_text()
    return files


def code_only(text: str) -> str:
    """Source without docstrings and comments, so prose may mention forbidden words."""
    text = re.sub(r'"""(.*?)"""', "", text, flags=re.S)
    return "\n".join(line.split("#")[0] for line in text.splitlines())


class EnvironmentPinTest(unittest.TestCase):
    def test_requirements_pin_exactly_one_package_with_the_verified_version(self):
        lines = [l.strip() for l in (SOLVER_DIR / "requirements.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
        self.assertEqual(lines, ["ortools==9.15.6755"])

    def test_installed_ortools_is_the_pinned_version(self):
        self.assertEqual(ortools.__version__, "9.15.6755")

    def test_python_version_file_matches_the_interpreter(self):
        pinned = (SOLVER_DIR / ".python-version").read_text().strip()
        self.assertEqual(pinned, "3.14.7")
        self.assertEqual(tuple(pinned.split(".")[:2]), (str(sys.version_info.major), str(sys.version_info.minor)))


class ArchitecturalProhibitionsTest(unittest.TestCase):
    def test_no_solution_hints_anywhere_in_the_production_code(self):
        for name, text in production_sources().items():
            self.assertIsNone(re.search(r"add_hint|AddHint|clear_hints|ClearHints|solution_hint|fix_variables_to_their_hinted_value", code_only(text)), name)

    def test_a_built_model_carries_no_hint(self):
        for inp in (
            make_input(5, 6, all_continue(6), [("a", "S", "T", 5), ("b", "S", "U", 4)]),
            golden_input(golden_cases()[0]),
        ):
            built = build_model(parse_problem(inp))
            self.assertEqual(len(built.model.proto.solution_hint.vars), 0)
            self.assertEqual(len(built.model.proto.solution_hint.values), 0)

    def test_no_database_orm_or_network_access(self):
        forbidden = r"psycopg|asyncpg|sqlalchemy|sqlite3|prisma|postgres|DATABASE_URL|socket|http\.client|urllib|requests|aiohttp"
        for name, text in production_sources().items():
            self.assertIsNone(re.search(forbidden, code_only(text), re.I), name)

    def test_no_extra_processes_or_parallelism_inside_the_solver(self):
        for name, text in production_sources().items():
            self.assertIsNone(re.search(r"multiprocessing|concurrent\.futures|subprocess|os\.fork|joblib", code_only(text)), name)
            if name != "watchdog.py":
                self.assertIsNone(re.search(r"import threading|from threading", code_only(text)), name)

    def test_only_the_solver_itself_imports_ortools(self):
        importers = sorted(n for n, t in production_sources().items() if re.search(r"^\s*(import ortools|from ortools)", code_only(t), re.M))
        self.assertEqual(importers, ["model.py", "solve.py"])

    def test_the_only_third_party_dependency_is_ortools(self):
        stdlib = set(sys.stdlib_module_names) | {"timetable_solver"}
        for name, text in production_sources().items():
            for module in re.findall(r"^\s*(?:import|from)\s+([A-Za-z_][\w]*)", code_only(text), re.M):
                self.assertTrue(module in stdlib or module in ("ortools", "__future__"), f"{name}: {module}")


if __name__ == "__main__":
    unittest.main()
