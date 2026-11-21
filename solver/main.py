"""Solver entry point:  python solver/main.py < input.json > output.json

The monotonic clock and the parent process id are read before anything heavy is imported: the time budget of the
request also covers interpreter and OR-Tools start-up, and the parent-death watchdog must know who its parent was
BEFORE the (slow) OR-Tools import, or a parent that dies during start-up would be mistaken for the legitimate one.
See timetable_solver/cli.py for the protocol and exit codes.
"""
import os
import time

_PROCESS_START = time.monotonic()
_PARENT_PID = os.getppid()

import sys  # noqa: E402

from timetable_solver.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(_PROCESS_START, _PARENT_PID))
