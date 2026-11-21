"""Command-line protocol: one JSON document on stdin, one JSON document on stdout, logs on stderr.

The request is self-delimiting (see request_reader.py): the solver starts as soon as one complete JSON document has
arrived and does not wait for end-of-file, which a parent's stdio socket pair does not reliably deliver.

Exit codes
  0  an output document was printed. Its `status` carries the result (OPTIMAL, FEASIBLE, INFEASIBLE, UNKNOWN,
     MODEL_INVALID or INPUT_INVALID); the process itself did not fail.
  2  the input could not even be answered with a contract output: not valid JSON, larger than the size cap, or
     without a usable requestId. Nothing is printed on stdout.
  3  internal error (an unexpected exception, or the produced output violated the contract). Nothing is printed
     on stdout; the traceback goes to stderr.
  4  the parent process died (see watchdog.py). Nothing is printed.

The solver prints the output document exactly once and never prints anything else on stdout. It never turns a
failure into a result: a process that cannot produce a verified output exits non-zero instead.
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from typing import Any, BinaryIO, Callable, TextIO

from .contract import ContractError, extract_request_id, parse_problem, validate_output
from .request_reader import read_request
from .solve import input_invalid_output, solve
from .watchdog import start_parent_watchdog

MAX_STDIN_BYTES = 32 * 1024 * 1024
EXIT_OK = 0
EXIT_BAD_INPUT = 2
EXIT_INTERNAL = 3


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-standard JSON constant {name}")


def run(
    data: bytes,
    *,
    process_start: float,
    stdout: BinaryIO,
    stderr: TextIO,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """Process one request. Separated from main() so tests can drive it without a subprocess."""
    if len(data) > MAX_STDIN_BYTES:
        print(f"solver: input exceeds {MAX_STDIN_BYTES} bytes", file=stderr)
        return EXIT_BAD_INPUT
    try:
        raw = json.loads(data.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError) as error:
        print(f"solver: input is not valid JSON ({type(error).__name__})", file=stderr)
        return EXIT_BAD_INPUT
    request_id = extract_request_id(raw)
    if request_id is None:
        print("solver: input has no usable requestId", file=stderr)
        return EXIT_BAD_INPUT

    try:
        try:
            problem = parse_problem(raw)
        except ContractError as error:
            output = input_invalid_output(request_id, error.messages, clock() - process_start)
        else:
            output = solve(problem, process_start=process_start, clock=clock)
        validate_output(output)  # never print a document the backend would have to reject
    except Exception:  # noqa: BLE001 - any failure must end as a non-zero exit, never as a result
        traceback.print_exc(file=stderr)
        return EXIT_INTERNAL

    stdout.write(json.dumps(output, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    stdout.flush()
    diagnostics = output["diagnostics"]
    print(
        f"solver: status={output['status']} stoppedBy={diagnostics['stoppedBy']} entries={len(output['entries'])} "
        f"wall={diagnostics['wallSeconds']}s",
        file=stderr,
    )
    return EXIT_OK


def main(process_start: float, parent_pid: int | None = None) -> int:
    start_parent_watchdog(initial_parent=parent_pid)
    data = read_request(sys.stdin.fileno(), MAX_STDIN_BYTES)
    return run(data, process_start=process_start, stdout=sys.stdout.buffer, stderr=sys.stderr)
