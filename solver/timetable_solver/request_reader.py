"""Self-delimiting request reader.

The request is ONE JSON document (an object) on stdin. The reader returns as soon as that document is complete; it
does not wait for end-of-file. This is deliberate: when Node feeds a child process through its stdio socket pair,
the end-of-input signal is not reliably delivered (measured: a trivial script that does `sys.stdin.buffer.read()`
hung in about 1 of 40 runs under child_process.spawnSync on macOS with Node 24, with no solver involved). A solver
that waited for EOF would sit idle until the backend's kill deadline.

Rules
  * leading whitespace is skipped;
  * if the first significant byte is '{' or '[' the document ends at its matching close bracket (string and
    escape aware); anything after it is ignored;
  * anything else cannot be a request: the reader falls back to reading until EOF (the input is then rejected by
    the caller as malformed);
  * reading stops once more than `limit` bytes have arrived (the caller rejects the oversize input).
"""
from __future__ import annotations

import os
import re

_STRUCTURAL = re.compile(rb'["\\{}\[\]]')
_WHITESPACE = b" \t\r\n"
CHUNK_SIZE = 64 * 1024


class _Scanner:
    def __init__(self) -> None:
        self.mode: str | None = None  # None until the first significant byte, then "json" or "other"
        self.depth = 0
        self.in_string = False
        self.skip_until = 0  # bytes before this index belong to an escape sequence
        self.scanned = 0

    def feed(self, buf: bytearray) -> int | None:
        """Scan newly arrived bytes. Returns the end offset of the document once it is complete, else None."""
        if self.mode is None:
            index = self.scanned
            while index < len(buf) and buf[index] in _WHITESPACE:
                index += 1
            if index == len(buf):
                self.scanned = index
                return None
            self.mode = "json" if buf[index] in b"{[" else "other"
            self.scanned = index
        if self.mode != "json":
            return None
        for match in _STRUCTURAL.finditer(buf, self.scanned):
            position = match.start()
            if position < self.skip_until:
                continue
            char = buf[position]
            if self.in_string:
                if char == 0x5C:  # backslash: the next byte is escaped, whatever it is
                    self.skip_until = position + 2
                elif char == 0x22:
                    self.in_string = False
            elif char == 0x22:
                self.in_string = True
            elif char in b"{[":
                self.depth += 1
            elif char in b"}]":
                self.depth -= 1
                if self.depth == 0:
                    return position + 1
        self.scanned = len(buf)
        return None


def read_request(fd: int, limit: int, chunk_size: int = CHUNK_SIZE) -> bytes:
    """Read one request from a file descriptor. May return more than `limit` bytes (never more than limit plus one
    chunk) to tell the caller the input is oversize; returns what it has on EOF."""
    buffer = bytearray()
    scanner = _Scanner()
    while True:
        part = os.read(fd, chunk_size)
        if not part:
            return bytes(buffer)  # EOF
        buffer += part
        if len(buffer) > limit:
            return bytes(buffer)
        end = scanner.feed(buffer)
        if end is not None:
            return bytes(buffer[:end])
