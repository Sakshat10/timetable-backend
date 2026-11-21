"""A fake solver for testing the Node SolverClient: ONE script, many behaviours, selected by argv[1].

It reads the request with the REAL self-delimiting reader of the production solver, so it behaves exactly like the
production process with respect to stdin. argv[2] is an optional marker string that makes the process findable in `ps`.
Test fixture only: it is not part of the application.
"""
import hashlib
import json
import os
import select
import signal
import subprocess
import sys
import time

# Like the real solver, end when the parent dies, so a killed test run can never leak fake processes.
import threading  # noqa: E402
_PARENT = os.getppid()


def _watch_parent():
    while True:
        time.sleep(1.0)
        if os.getppid() != _PARENT:
            os._exit(4)


threading.Thread(target=_watch_parent, daemon=True).start()

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "solver"))
from timetable_solver.request_reader import read_request  # noqa: E402

mode = sys.argv[1] if len(sys.argv) > 1 else "echo"


def read_all():
    data = read_request(0, 128 * 1024 * 1024)
    return data, json.loads(data.decode("utf-8"))


def diagnostics(messages=None, stopped_by="TIME_LIMIT"):
    return {
        "objectiveValue": None, "bestObjectiveBound": None, "wallSeconds": 0.01, "numWorkers": 1, "seed": 1,
        "ortoolsVersion": "fake", "numBooleans": None, "numConstraints": None, "conflicts": None, "branches": None,
        "stoppedBy": stopped_by, "messages": (messages or [])[:50],
    }


def document(req, status="UNKNOWN", entries=None, messages=None, **over):
    doc = {"contractVersion": "1.0", "requestId": req["requestId"], "status": status, "entries": entries or [], "diagnostics": diagnostics(messages)}
    doc.update(over)
    return doc


def emit(doc, wrap=("", "")):
    sys.stdout.write(wrap[0] + json.dumps(doc) + wrap[1])
    sys.stdout.flush()


def stdin_is_open():
    """After the request was read: is the write end still open? True when nothing but the trailing newline arrives."""
    while True:
        ready, _, _ = select.select([0], [], [], 0.4)
        if not ready:
            return True
        if os.read(0, 4096) == b"":
            return False


if mode == "slow-start":
    time.sleep(1.0)
    mode = "echo"

if mode == "exit-no-read":
    sys.exit(1)

if mode == "no-read":
    time.sleep(10_000)

raw, req = read_all()

if mode == "echo":
    ids = [s["id"] for s in req["sections"]]
    emit(document(req, messages=[f"bytes={len(raw)}", f"sha256={hashlib.sha256(raw).hexdigest()}", f"stdin_open={str(stdin_is_open()).lower()}",
                                 f"section0={ids[0]}", f"sections={len(ids)}", f"requestId={req['requestId']}"]))
elif mode == "hang":
    time.sleep(10_000)
elif mode == "ignore-sigterm":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    sys.stderr.write("ignoring SIGTERM\n")
    sys.stderr.flush()
    time.sleep(10_000)
elif mode == "slow-term-exit0":
    signal.signal(signal.SIGTERM, lambda *a: (time.sleep(0.3), os._exit(0)))
    time.sleep(10_000)
elif mode == "term-exit7":
    signal.signal(signal.SIGTERM, lambda *a: os._exit(7))
    time.sleep(10_000)
elif mode == "crash3":
    sys.stderr.write("Traceback (most recent call last):\n  File \"fake\", line 1\nRuntimeError: simulated internal error\n")
    sys.exit(3)
elif mode == "exit2":
    sys.exit(2)
elif mode == "exit1":
    sys.exit(1)
elif mode == "segv":
    os.kill(os.getpid(), signal.SIGSEGV)
elif mode == "kill9-self":
    os.kill(os.getpid(), signal.SIGKILL)
elif mode == "not-json":
    print("hello, this is not json")
elif mode == "empty":
    pass
elif mode == "bad-json":
    sys.stdout.write('{"contractVersion": "1.0", "requestId": ')
elif mode == "array":
    print("[]")
elif mode == "string":
    print('"ok"')
elif mode == "wrong-request-id":
    emit(document(req, requestId="someone-else"))
elif mode == "wrong-version":
    emit(document(req, contractVersion="9.9"))
elif mode == "extra-field":
    emit(document(req, debug=True))
elif mode == "invalid-timetable":
    entries = []
    for a in req["assignments"]:
        entries += [{"assignmentId": a["id"], "sectionId": a["sectionId"], "subjectId": a["subjectId"], "teacherId": a["teacherId"],
                     "dayOfWeek": "MONDAY", "periodNumber": 1} for _ in range(a["periodsPerWeek"])]
    emit(document(req, status="FEASIBLE", entries=entries))
elif mode == "whitespace":
    emit(document(req), wrap=("\n\n   \t", "   \n\n\n"))
elif mode == "stderr-noise":
    for i in range(3000):
        sys.stderr.write(f"warning {i}: " + "x" * 90 + "\x00\x07\x1b[31m\n")
    sys.stderr.flush()
    emit(document(req))
elif mode == "big-stdout":
    sys.stdout.write(" " * (3 * 1024 * 1024) + json.dumps(document(req)))
    sys.stdout.flush()
    time.sleep(30)
elif mode == "env-dump":
    emit(document(req, messages=[f"env:{k}" for k in sorted(os.environ)]))
elif mode == "grandchild":
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)", sys.argv[2] if len(sys.argv) > 2 else "grandchild"])
    sys.stderr.write(f"grandchild={child.pid}\n")
    sys.stderr.flush()
    time.sleep(10_000)
elif mode == "partial-then-hang":
    sys.stdout.write('{"contractVersion": "1.0", "requestId": "' + req["requestId"] + '", "status": ')
    sys.stdout.flush()
    time.sleep(10_000)
elif mode == "output-then-hang":
    emit(document(req))
    time.sleep(10_000)
elif mode == "sleep-then-ok":
    time.sleep(1.5)
    emit(document(req))
elif mode == "cwd":
    emit(document(req, messages=[f"cwd={os.getcwd()}", f"argv0={os.path.basename(sys.argv[0])}", f"argv2={sys.argv[2] if len(sys.argv) > 2 else ''}"]))
else:
    sys.stderr.write(f"unknown fake mode {mode}\n")
    sys.exit(9)
