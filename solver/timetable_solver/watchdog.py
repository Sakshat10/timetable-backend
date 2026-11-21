"""Parent-death watchdog.

If the Node process that spawned the solver dies (crash, kill -9, a development reload), nobody is left to read
the result. A daemon thread notices that the parent process id changed (the process was re-parented) and ends the
solver immediately, so an orphaned solve cannot keep consuming CPU and memory until its own budget runs out.

Deliberately NOT done here: no self-imposed hard deadline. The kill deadline belongs to the backend; a solver that
ended itself with a non-zero exit would be indistinguishable from a crash and would defeat the approved rule that
a process killed at the watchdog deadline falls back to the baseline.
"""
from __future__ import annotations

import os
import threading
import time

EXIT_PARENT_DIED = 4


def start_parent_watchdog(interval_seconds: float = 1.0, initial_parent: int | None = None) -> threading.Thread:
    """`initial_parent` should be the parent pid read at the very first line of the process (main.py does this).
    Residual limitation: if the parent died before the process executed that first line, the orphan cannot be
    recognised; it then still ends by its own time budget."""
    initial_parent = os.getppid() if initial_parent is None else initial_parent

    def watch() -> None:
        while True:
            time.sleep(interval_seconds)
            if os.getppid() != initial_parent:
                os._exit(EXIT_PARENT_DIED)

    thread = threading.Thread(target=watch, name="parent-watchdog", daemon=True)
    thread.start()
    return thread
