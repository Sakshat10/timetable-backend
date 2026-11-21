"""The self-delimiting request reader: it must return as soon as one JSON document is complete, never wait for EOF,
and survive every possible way the bytes can be chunked."""
import json
import os
import random
import subprocess
import sys
import threading
import unittest

from timetable_solver.request_reader import read_request
from tests.helpers import MAIN, all_continue, make_input, options


def feed(chunks: list[bytes], limit: int = 1 << 20, close: bool = True, chunk_size: int = 64 * 1024):
    """Write chunks into a pipe and read them with read_request. With close=False the write end stays open, so a
    reader that waited for EOF would hang: the read runs in a thread that must finish on its own."""
    r, w = os.pipe()
    result: dict = {}

    def reader():
        result["data"] = read_request(r, limit, chunk_size)

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    for chunk in chunks:
        os.write(w, chunk)
    if close:
        os.close(w)
    t.join(timeout=5)
    finished = not t.is_alive()
    if not close:
        os.close(w)
        t.join(timeout=5)
    os.close(r)
    return result.get("data"), finished


class StopsAtTheEndOfTheDocumentTest(unittest.TestCase):
    def test_returns_without_eof_when_the_object_is_complete(self):
        data, finished = feed([b'{"a": 1}'], close=False)
        self.assertTrue(finished, "the reader waited for EOF")
        self.assertEqual(data, b'{"a": 1}')

    def test_an_array_document(self):
        data, finished = feed([b"[1, 2, 3]"], close=False)
        self.assertEqual((data, finished), (b"[1, 2, 3]", True))

    def test_nested_objects_and_arrays(self):
        doc = b'{"a": {"b": [1, {"c": []}]}, "d": [[], [{}]]}'
        self.assertEqual(feed([doc], close=False), (doc, True))

    def test_braces_and_brackets_inside_strings_do_not_end_the_document(self):
        doc = b'{"a": "}{][", "b": "x"}'
        self.assertEqual(feed([doc], close=False), (doc, True))

    def test_escaped_quotes_and_backslashes_inside_strings(self):
        for doc in (b'{"a": "he said \\"}\\" ok"}', b'{"a": "back\\\\"}', b'{"a": "\\\\\\"}\\""}', b'{"a": "\\n\\t\\u007d"}'):
            json.loads(doc)  # the fixtures are valid JSON
            self.assertEqual(feed([doc], close=False), (doc, True), doc)

    def test_leading_whitespace_is_skipped_and_trailing_bytes_are_ignored(self):
        self.assertEqual(feed([b'  \n\t{"a":1}\n'], close=False), (b'  \n\t{"a":1}', True))
        self.assertEqual(feed([b'{"a":1}{"b":2}'], close=False), (b'{"a":1}', True))
        self.assertEqual(feed([b'{"a":1}garbage'], close=True), (b'{"a":1}', True))

    def test_multibyte_utf8_inside_strings(self):
        doc = '{"id": "😀é世界", "x": [1]}'.encode()
        self.assertEqual(feed([doc], close=False), (doc, True))


class ChunkingTest(unittest.TestCase):
    DOC = json.dumps({"a": ["}{", "\\", '"', {"b": [1, 2, {"c": "x\\\"y}"}]}], "é": "😀"}).encode()

    def test_every_possible_split_point(self):
        for cut in range(1, len(self.DOC)):
            data, finished = feed([self.DOC[:cut], self.DOC[cut:]], close=False)
            self.assertTrue(finished, f"hung at split {cut}")
            self.assertEqual(data, self.DOC, f"split {cut}")

    def test_one_byte_at_a_time(self):
        data, finished = feed([bytes([b]) for b in self.DOC], close=False)
        self.assertEqual((data, finished), (self.DOC, True))

    def test_random_chunk_sizes(self):
        rnd = random.Random(1)
        for _ in range(200):
            cuts = sorted(rnd.sample(range(1, len(self.DOC)), rnd.randint(1, 8)))
            parts = [self.DOC[a:b] for a, b in zip([0] + cuts, cuts + [len(self.DOC)])]
            self.assertEqual(feed(parts, close=False), (self.DOC, True))

    def test_small_read_size(self):
        self.assertEqual(feed([self.DOC], close=False, chunk_size=3), (self.DOC, True))

    def test_a_large_realistic_document_in_odd_chunks(self):
        doc = json.dumps(make_input(5, 6, all_continue(6), [(f"a{i}", f"S{i % 40}", f"T{i % 25}", 1 + i % 4) for i in range(2000)], opts=options())).encode()
        self.assertGreater(len(doc), 200_000)
        chunks = [doc[i:i + 7919] for i in range(0, len(doc), 7919)]
        self.assertEqual(feed(chunks, close=False), (doc, True))


class FallbacksTest(unittest.TestCase):
    def test_eof_returns_what_arrived(self):
        self.assertEqual(feed([b'{"a": 1']), (b'{"a": 1', True))
        self.assertEqual(feed([b""]), (b"", True))
        self.assertEqual(feed([]), (b"", True))

    def test_a_document_that_does_not_start_with_a_bracket_is_read_until_eof(self):
        self.assertEqual(feed([b"not json at all"]), (b"not json at all", True))
        self.assertEqual(feed([b"  42  "]), (b"  42  ", True))
        self.assertEqual(feed([b'"a string"']), (b'"a string"', True))

    def test_whitespace_only_waits_for_eof(self):
        self.assertEqual(feed([b"   \n  "]), (b"   \n  ", True))

    def test_oversize_input_stops_reading_early(self):
        data, finished = feed([b"{" + b" " * 10_000], limit=1000, close=False, chunk_size=512)
        self.assertTrue(finished)
        self.assertGreater(len(data), 1000)
        self.assertLessEqual(len(data), 1000 + 512)

    def test_a_complete_document_exactly_at_the_limit_is_accepted(self):
        doc = b'{"a": "' + b"x" * 90 + b'"}'
        self.assertEqual(feed([doc], limit=len(doc), close=False), (doc, True))

    def test_unbalanced_closing_brackets_end_the_scan_without_crashing(self):
        data, finished = feed([b"{}}}"], close=False)
        self.assertEqual((data, finished), (b"{}", True))


class ThroughTheCliTest(unittest.TestCase):
    """The scenario that hung in the field: the parent writes the request and never closes stdin."""

    def test_the_solver_answers_while_stdin_is_still_open(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=10))
        proc = subprocess.Popen([sys.executable, str(MAIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            proc.stdin.write(json.dumps(inp).encode())
            proc.stdin.flush()  # deliberately NOT closed
            try:
                code = proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.fail("the solver waited for stdin EOF")
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(proc.stdout.read())["status"], "OPTIMAL")
        finally:
            if proc.poll() is None:
                proc.kill()
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    stream.close()
                except Exception:  # noqa: BLE001
                    pass

    def test_a_pretty_printed_request_works(self):
        inp = make_input(5, 6, all_continue(6), [("a", "S", "T", 5)], opts=options(timeLimitSeconds=10))
        proc = subprocess.run([sys.executable, str(MAIN)], input=json.dumps(inp, indent=2).encode() + b"\n", capture_output=True, timeout=60)
        self.assertEqual((proc.returncode, json.loads(proc.stdout)["status"]), (0, "OPTIMAL"))

    def test_an_incomplete_request_followed_by_eof_is_rejected_with_exit_2(self):
        proc = subprocess.run([sys.executable, str(MAIN)], input=b'{"requestId": "x", "options": {', capture_output=True, timeout=60)
        self.assertEqual((proc.returncode, proc.stdout), (2, b""))


if __name__ == "__main__":
    unittest.main()
