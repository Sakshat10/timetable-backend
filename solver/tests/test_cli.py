"""The command-line protocol: exit codes, stdout purity, malformed input, internal errors, parent-death watchdog."""
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from timetable_solver import cli
from timetable_solver.contract import validate_output
from tests.helpers import MAIN, all_continue, make_input, options, run_cli, synthetic_heavy


def small(**over):
    return make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=10), **over)


class ExitCodeZeroTest(unittest.TestCase):
    def test_a_valid_request_prints_exactly_one_conforming_json_document(self):
        code, out, err = run_cli(small())
        self.assertEqual(code, 0)
        validate_output(out)
        self.assertEqual((out["status"], out["requestId"], len(out["entries"])), ("OPTIMAL", "req-1", 5))
        lines = [l for l in err.strip().splitlines() if l]
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r"^solver: status=OPTIMAL stoppedBy=OPTIMAL entries=5 wall=")

    def test_stdout_is_a_single_json_document_and_nothing_else(self):
        proc = subprocess.run([sys.executable, str(MAIN)], input=json.dumps(small()).encode(), capture_output=True)
        text = proc.stdout.decode()
        self.assertEqual(json.loads(text)["status"], "OPTIMAL")
        self.assertEqual(text, text.strip())
        self.assertNotIn("\n", text)
        self.assertEqual(proc.stdout.count(b'"contractVersion"'), 1)

    def test_an_infeasible_problem_is_still_exit_code_0_with_the_status_carrying_the_result(self):
        code, out, _ = run_cli(make_input(1, 2, all_continue(2), [("a", "S", "T", 3)]))
        self.assertEqual((code, out["status"]), (0, "INFEASIBLE"))

    def test_a_rejected_payload_with_a_request_id_is_answered_not_crashed(self):
        bad = small()
        bad["assignments"][0]["teacherId"] = "ghost"
        code, out, _ = run_cli(bad)
        self.assertEqual((code, out["status"], out["entries"]), (0, "INPUT_INVALID", []))
        validate_output(out)

    def test_unknown_is_exit_code_0(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=5, reproducible=True, deterministicTimeLimit=0.001))
        code, out, _ = run_cli(inp)
        self.assertEqual(code, 0)
        self.assertIn(out["status"], ("UNKNOWN", "OPTIMAL", "FEASIBLE"))  # a one-lesson problem may be solved before the limit bites
        validate_output(out)

    def test_the_cli_honours_the_whole_process_budget(self):
        inp = make_input(5, 8, all_continue(8), synthetic_heavy(60, D=5, K=8), opts=options(timeLimitSeconds=6, numWorkers=2))
        t0 = time.monotonic()
        code, out, _ = run_cli(inp, timeout=60)
        elapsed = time.monotonic() - t0
        self.assertEqual(code, 0)
        self.assertLess(elapsed, 6 + 4, f"{elapsed:.1f}s")
        validate_output(out)


class ExitCodeTwoTest(unittest.TestCase):
    """Input that cannot even be answered with a contract output: nothing on stdout, exit code 2."""

    def assert_bad(self, raw: bytes):
        code, out, err = run_cli(None, raw=raw)
        self.assertEqual((code, out), (2, None), err)
        self.assertTrue(err.strip())
        return err

    def test_not_json(self):
        self.assert_bad(b"this is not json")
        self.assert_bad(b"")
        self.assert_bad(b"{")
        self.assert_bad(b'{"requestId": "x",}')

    def test_invalid_utf8(self):
        self.assert_bad(b'{"requestId": "\xff\xfe"}')

    def test_non_standard_json_constants(self):
        self.assert_bad(b'{"requestId": "x", "a": NaN}')
        self.assert_bad(b'{"requestId": "x", "a": Infinity}')

    def test_not_an_object_or_without_a_usable_request_id(self):
        for raw in (b"[]", b'"x"', b"5", b"null", b"{}", b'{"requestId": 5}', b'{"requestId": ""}', b'{"requestId": null}', ('{"requestId": "%s"}' % ("r" * 101)).encode()):
            self.assert_bad(raw)

    def test_input_larger_than_the_cap(self):
        err = self.assert_bad(b" " * (cli.MAX_STDIN_BYTES + 1))
        self.assertIn("exceeds", err)

    def test_the_error_never_echoes_the_payload(self):
        err = self.assert_bad(b'{"requestId": "x", "secret": "hunter2", "a": NaN}')
        self.assertNotIn("hunter2", err)


class ExitCodeThreeTest(unittest.TestCase):
    """Internal errors never turn into results: nothing on stdout."""

    def run_with(self, patched_solve):
        stdout, stderr = io.BytesIO(), io.StringIO()
        with mock.patch.object(cli, "solve", patched_solve):
            code = cli.run(json.dumps(small()).encode(), process_start=0.0, stdout=stdout, stderr=stderr, clock=lambda: 0.1)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_an_unexpected_exception_is_exit_3_with_a_traceback_and_no_stdout(self):
        def boom(*a, **k):
            raise RuntimeError("model exploded")
        code, out, err = self.run_with(boom)
        self.assertEqual((code, out), (3, b""))
        self.assertIn("RuntimeError", err)

    def test_an_output_that_violates_the_contract_is_never_printed(self):
        from timetable_solver.solve import build_output
        def bad_output(problem, **k):
            doc = build_output(problem.request_id, "OPTIMAL", [], wall_seconds=0.1, options=problem.options, stopped_by="OPTIMAL", messages=[])
            return doc  # OPTIMAL without entries violates the contract
        code, out, err = self.run_with(bad_output)
        self.assertEqual((code, out), (3, b""))
        self.assertIn("ContractError", err)

    def test_an_output_with_an_unknown_field_is_never_printed(self):
        def extra(problem, **k):
            doc = __import__("timetable_solver.solve", fromlist=["x"]).input_invalid_output(problem.request_id, ["x"], 0.1)
            doc["debug"] = True
            return doc
        code, out, _ = self.run_with(extra)
        self.assertEqual((code, out), (3, b""))

    def test_the_process_never_converts_a_failure_into_a_baseline_like_result(self):
        def boom(*a, **k):
            raise MemoryError("out of memory")
        code, out, _ = self.run_with(boom)
        self.assertEqual((code, out), (3, b""))


class ParentWatchdogTest(unittest.TestCase):
    def test_an_orphaned_solver_ends_itself_within_seconds(self):
        # a long solve (100 sections, a 2-minute budget) started by a shell that stays alive for 3 s and then exits:
        # the solver is orphaned mid-solve, which is exactly what a Node crash looks like
        inp = make_input(5, 8, all_continue(8), synthetic_heavy(100, D=5, K=8), opts=options(timeLimitSeconds=120, numWorkers=1))
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(inp, f)
            path = f.name

        def alive(pid):
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False

        pid = None
        launcher = subprocess.Popen(
            ["sh", "-c", f'"{sys.executable}" "{MAIN}" < "{path}" > /dev/null 2>&1 & echo $!; sleep 3'],
            stdout=subprocess.PIPE, text=True,
        )
        try:
            pid = int(launcher.stdout.readline().strip())
            time.sleep(1.5)
            self.assertIsNone(launcher.poll(), "the launcher (the solver's parent) must still be alive here")
            self.assertTrue(alive(pid), "the solver must keep running while its parent is alive")
            launcher.wait(timeout=10)  # the parent exits: the solver is now an orphan
            deadline = time.monotonic() + 10
            while alive(pid) and time.monotonic() < deadline:
                time.sleep(0.2)
            self.assertFalse(alive(pid), "the orphaned solver kept running after its parent died")
        finally:
            os.unlink(path)
            if launcher.poll() is None:
                launcher.kill()
            launcher.stdout.close()
            if pid is not None and alive(pid):
                os.kill(pid, signal.SIGKILL)

    def test_a_parent_that_dies_during_start_up_is_still_detected(self):
        """The regression for the real defect found in Phase 2: the parent exits while the solver is still importing
        OR-Tools (about 0.3-0.5 s). The parent pid must have been recorded at the first line of main.py, before that
        import, or the already re-parented process would mistake PID 1 for its legitimate parent and run on."""
        inp = make_input(5, 8, all_continue(8), synthetic_heavy(100, D=5, K=8), opts=options(timeLimitSeconds=120, numWorkers=1))
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(inp, f)
            path = f.name

        def alive(pid):
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False

        pid = None
        try:
            # the launcher lives 0.12 s: longer than interpreter start-up (~0.02 s), shorter than the OR-Tools import (~0.27 s)
            launcher = subprocess.run(
                ["sh", "-c", f'"{sys.executable}" "{MAIN}" < "{path}" > /dev/null 2>&1 & echo $!; sleep 0.12'],
                capture_output=True, text=True, timeout=30,
            )
            pid = int(launcher.stdout.strip())
            deadline = time.monotonic() + 10
            while alive(pid) and time.monotonic() < deadline:
                time.sleep(0.2)
            self.assertFalse(alive(pid), "a parent that died during start-up went undetected")
        finally:
            os.unlink(path)
            if pid is not None and alive(pid):
                os.kill(pid, signal.SIGKILL)

    def test_the_watchdog_ends_the_process_with_exit_code_4_when_the_parent_changes(self):
        """Deterministic unit test of the mechanism: pretend the original parent was a different process."""
        code = (
            "import time\n"
            "from timetable_solver.watchdog import start_parent_watchdog\n"
            "start_parent_watchdog(interval_seconds=0.1, initial_parent=999999)\n"
            "time.sleep(30)\n"
        )
        t0 = time.monotonic()
        proc = subprocess.run([sys.executable, "-c", code], cwd=str(MAIN.parent), capture_output=True, timeout=20)
        self.assertEqual(proc.returncode, 4)
        self.assertLess(time.monotonic() - t0, 5)

    def test_the_parent_pid_is_recorded_before_the_heavy_imports(self):
        text = MAIN.read_text()
        self.assertLess(text.index("_PARENT_PID = os.getppid()"), text.index("from timetable_solver.cli import main"))
        self.assertLess(text.index("_PROCESS_START = time.monotonic()"), text.index("from timetable_solver.cli import main"))

    def test_a_solver_whose_parent_is_alive_keeps_running(self):
        inp = small()
        inp["options"]["timeLimitSeconds"] = 10
        proc = subprocess.Popen([sys.executable, str(MAIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, _ = proc.communicate(json.dumps(inp).encode(), timeout=60)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(out)["status"], "OPTIMAL")

    def test_the_watchdog_thread_is_a_daemon_that_does_not_block_exit(self):
        from timetable_solver.watchdog import start_parent_watchdog
        t = start_parent_watchdog(interval_seconds=60)
        self.assertTrue(t.daemon)
        self.assertTrue(t.is_alive())


if __name__ == "__main__":
    unittest.main()
