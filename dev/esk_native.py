"""Serve xEskWeb and its disk-backed Windows recorder on one loopback origin."""
from contextlib import nullcontext
import argparse
import hashlib
import json
import mimetypes
import mmap
import os
import re
import select
import shutil
import subprocess
import threading
import time
import uuid
import webbrowser
from functools import lru_cache
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


RATES = (41666666, 83333333, 166666666, 333333333, 500000000)
WINDOW = 65536
EDGE_CHUNK = 4 * 1024 ** 2
LOW_NIBBLE = bytes(i & 15 for i in range(256))
HIGH_NIBBLE = bytes(i >> 4 for i in range(256))
GIB = 1024 ** 3
MAX_QUOTA_GIB = (2**53 - 1) // GIB


@lru_cache(maxsize=256)
def covered_bytes(low, high):
    return bytes(b for b in range(256) if b & low == low and b | high == high)


def activity_masks(data, packed, odd):
    # Seed the masks from a short prefix. translate checks every remaining byte
    # in C and returns only values that can change the masks (including rare pulses).
    low, high = 255, 0
    if odd:
        last = data[-1] & 15
        data = data[:-1]
        low = high = last | (last << 4)
    for value in set(data[:64]):
        low &= value
        high |= value
    if low or high != 255:
        for value in set(data.translate(None, covered_bytes(low, high))):
            low &= value
            high |= value
    if packed:
        low = low & (low >> 4) & 15
        high = (high | (high >> 4)) & 15
    return low | (high << 8)


def stop_note(row, receipt):
    if receipt.get("finish_verified") is True:
        return "Hardware end of stream verified."
    if not row.get("loop") and row["samples"] == row["limit"]:
        message = "Recording limit reached."
    else:
        message = "Recording stopped."
    if receipt.get("cleanup_reads", {}).get("failed_reads"):
        message += " A USB read failed during Stop."
    return message + " The hardware tail is unverified."


class LoopSink:
    """The CLI writes its original wire bytes to a local pipe. Bound only the disk sink."""
    def __init__(self, path, capacity, memory=None):
        self.memory = memory
        import ctypes
        from ctypes import wintypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateNamedPipeW.restype = wintypes.HANDLE
        self.name = r"\\.\pipe\xesk-" + uuid.uuid4().hex
        self.handle = self.kernel.CreateNamedPipeW(self.name, 0x80001, 8, 1, 0, 1024**2, 0, None)
        if self.handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        self.path, self.capacity = path, capacity
        self.total = 0
        self.lock = threading.RLock()
        self.error = None
        self.thread = None
        self.connected = threading.Event()

    def close_pipe(self):
        from ctypes import wintypes
        if self.handle is not None:
            self.kernel.CloseHandle(wintypes.HANDLE(self.handle))
            self.handle = None

    def start(self, process):
        self.thread = threading.Thread(target=self.consume, args=(process,), daemon=True)
        self.thread.start()

    def consume(self, process):
        import ctypes
        from ctypes import wintypes
        import msvcrt
        try:
            handle = wintypes.HANDLE(self.handle)
            if not self.kernel.ConnectNamedPipe(handle, None) and ctypes.get_last_error() != 535:
                raise ctypes.WinError(ctypes.get_last_error())
            self.connected.set()
            fd = msvcrt.open_osfhandle(self.handle, os.O_RDONLY | os.O_BINARY)
            self.handle = None  # fd now owns it
            with os.fdopen(fd, "rb", buffering=0) as source, (nullcontext(self.memory) if self.memory is not None else self.path.open("w+b", buffering=0)) as sink:
                while True:
                    data = source.read(1024**2)
                    if not data:
                        break
                    with self.lock:
                        self.total = self.append(sink, self.capacity, self.total, data)
        except OSError as exc:
            self.error = str(exc)
            if process.poll() is None:
                process.terminate()
        finally:
            self.close_pipe()

    @staticmethod
    def append(sink, capacity, total, data):
        end = total + len(data)
        data = memoryview(data)[-capacity:]
        pos = (end - len(data)) % capacity
        first = min(len(data), capacity - pos)
        sink.seek(pos)
        if sink.write(data[:first]) != first:
            raise OSError("Short loop write")
        if first < len(data):
            sink.seek(0)
            if sink.write(data[first:]) != len(data) - first:
                raise OSError("Short loop write")
        return end


class Recordings:
    def __init__(self, directory, executable, serial, budget):
        self.directory = directory
        self.executable = executable
        self.serial = serial
        self.launch_budget = budget
        self.preference = directory / ".archive-limit.json"
        self.budget = budget
        if self.preference.exists():
            saved = json.loads(self.preference.read_text(encoding="utf8"))
            saved_bytes = self.quota_bytes(saved)
            self.budget = saved_bytes if budget is None else min(saved_bytes, budget)
        self.ram_loops = {}
        self.lock = threading.RLock()
        self.loop_sink = None
        self.process = None
        self.active = None

    def path(self, key, suffix):
        if not isinstance(key, str) or not re.fullmatch("[0-9a-f]{32}", key):
            raise ValueError("Invalid recording ID")
        return self.directory / (key + suffix)

    def metadata(self, key):
        return json.loads(self.path(key, ".record").read_text(encoding="utf8"))

    def save(self, row):
        temp = self.path(row["id"], ".tmp")
        temp.write_text(json.dumps(row), encoding="utf8")
        temp.replace(self.path(row["id"], ".record"))

    def available(self):
        free = shutil.disk_usage(self.directory).free
        if self.budget is not None:
            used = sum(p.stat().st_size for p in self.directory.iterdir() if p.is_file())
            free = min(free, self.budget - used)
        return max(0, free - 2**20)  # Leave room for the receipt and archive metadata.

    @staticmethod
    def quota_bytes(gib):
        if type(gib) is not int or not 1 <= gib <= MAX_QUOTA_GIB:
            raise ValueError("Enter a positive whole number of GiB")
        return gib * GIB

    def storage(self):
        return dict(available=self.available(), budget=self.budget, launchBudget=self.launch_budget)

    def set_quota(self, gib):
        self.refresh()
        if self.process:
            raise ValueError("Stop the active recording before changing the archive limit")
        budget = self.launch_budget if gib is None else self.quota_bytes(gib)
        if self.launch_budget is not None and budget > self.launch_budget:
            raise ValueError("Archive limit exceeds the launcher limit")
        if gib is None:
            self.preference.unlink(missing_ok=True)
        else:
            temp = self.preference.with_suffix(".tmp")
            temp.write_text(json.dumps(gib), encoding="utf8")
            temp.replace(self.preference)
        self.budget = budget
        return self.storage()

    def start(self, rate, bank, samples, serial=None, loop=False, ram_mib=0):
        self.refresh()
        if self.process:
            raise ValueError("Another native recording is active")
        if serial is not None and (not isinstance(serial, str) or not 1 <= len(serial) <= 126 or not serial.isprintable()):
            raise ValueError("Invalid USB serial number")
        if self.serial and serial and self.serial != serial:
            raise ValueError("The selected USB device differs from the recorder's configured serial number")
        if type(rate) is not int or rate not in RATES or bank not in ("lower", "upper"):
            raise ValueError("Unsupported USB profile")
        if samples is not None and (type(samples) is not int or not 0 < samples < 2**53):
            raise ValueError("Invalid sample count")
        if type(loop) is not bool or (loop and samples is None):
            raise ValueError("Loop needs a sample window")
        factor = 2 if rate == RATES[-1] else 1
        available = self.available()
        limit = min(available, (2**53 - 1) // factor) if samples is None else (samples + factor - 1) // factor
        if type(ram_mib) is not int or not 0 <= ram_mib <= (2**53 - 1) // 2**20:
            raise ValueError("Invalid Loop RAM budget")
        in_ram = loop and limit <= ram_mib * 2**20
        if in_ram and self.ram_loops:
            raise ValueError("Save or discard the pending RAM loop first")
        if limit < 1 or (not in_ram and limit > available):
            raise ValueError("Recording exceeds available capture storage")
        key = uuid.uuid4().hex
        row = dict(id=key, title=datetime.now().isoformat(timespec="seconds"), rate=rate, bank=bank,
                   state="recording", samples=0, limit=samples or limit * factor, note="")
        if loop:
            row["loop"] = True
        if in_ram:
            try:
                memory = mmap.mmap(-1, limit)
            except (OSError, OverflowError, MemoryError) as exc:
                raise ValueError("RAM allocation failed. Reduce Samples or the Loop RAM limit to use disk.") from exc
            row["volatile"] = True
        self.save(row)
        wire_limit = (2**53 - 1) // factor if loop else limit
        # The CLI needs a deadline. Allow long recordings to reach their byte limit.
        duration = max(86400, (wire_limit * factor + rate - 1) // rate + 60)
        cmd = [str(self.executable), "--continuous", "--sample-rate", str(rate),
               "--channel-mask", str((15 if bank == "lower" else 240) if factor == 2 else 255),
               "--duration", str(duration), "--record-bytes", str(wire_limit), "--stop-on-stdin-close",
               "--output", str(self.path(key, ".bin")), "--json", str(self.path(key, ".json"))]
        if serial or self.serial:
            cmd += ["--serial", serial or self.serial]
        try:
            if loop:
                self.loop_sink = LoopSink(self.path(key, ".bin"), limit, memory) if in_ram else LoopSink(self.path(key, ".bin"), limit)
                if in_ram:
                    self.ram_loops[key] = memory
                cmd[cmd.index("--output") + 1] = self.loop_sink.name
            with self.path(key, ".log").open("wb") as log:
                self.process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=log, stderr=log,
                                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if self.loop_sink:
                self.loop_sink.start(self.process)
        except OSError:
            if in_ram:
                self.ram_loops.pop(key, None)
                memory.close()
            if self.loop_sink:
                self.loop_sink.close_pipe()
                self.loop_sink = None
            row.update(state="failed", note="Could not start the native recorder")
            self.save(row)
            raise
        self.active = key
        return row

    def refresh(self):
        if not self.process or self.process.poll() is None:
            return
        ring = self.loop_sink
        if ring and ring.thread.is_alive():
            if not ring.connected.is_set():
                # The recorder may have failed before opening its output pipe.
                try:
                    with open(ring.name, "wb"):
                        pass
                except OSError:
                    pass
            return
        proc, key = self.process, self.active
        proc.stdin.close()
        row = self.metadata(key)
        try:
            if ring and ring.error:
                raise ValueError(ring.error)
            size = min(ring.total, ring.capacity) if key in self.ram_loops else self.path(key, ".bin").stat().st_size
            received = ring.total if ring else size
            receipt = json.loads(self.path(key, ".json").read_text())
            packed = row["rate"] == RATES[-1]
            factor = 2 if packed else 1
            mask = (15 if row["bank"] == "lower" else 240) if packed else 255
            if (proc.returncode or receipt["bytes"] != received or not size
                    or size != min(received, (row["limit"] + factor - 1) // factor)
                    or receipt["actual_sample_rate"] != row["rate"] or receipt["channel_mask"] != mask):
                raise ValueError("Incomplete acquisition")
            if any(receipt[k] for k in ("overruns", "timing_errors", "ownership_errors", "usb_errors")):
                raise ValueError("Capture integrity check failed")
            cleanup = receipt["cleanup_reads"]
            if not cleanup["drain_completed"] or cleanup["unresolved_reads"]:
                raise ValueError("USB cleanup is incomplete")
            row["samples"] = min(row["limit"], received * factor)
            if ring:
                row["firstSample"] = received * factor - row["samples"]
            row["state"] = "saved"
            row["note"] = stop_note(row, receipt)
        except (OSError, KeyError, ValueError) as exc:
            if key in self.ram_loops:
                self.ram_loops.pop(key).close()
            row.update(state="failed", note=f"{exc}. See {key}.log and the capture receipt.")
        self.save(row)
        self.process = self.active = self.loop_sink = None

    def status(self, key):
        self.refresh()
        row = self.metadata(key)
        if row.get("volatile") and row["state"] == "saved" and key not in self.ram_loops:
            row.update(state="failed", note="Unsaved RAM loop expired when the recorder closed.")
        if row["state"] == "saved" and not row["note"]:
            # Earlier helpers left the note empty when all Windows reads retired cleanly.
            try:
                receipt = json.loads(self.path(key, ".json").read_text())
            except (OSError, ValueError):
                receipt = {}
            row["note"] = stop_note(row, receipt)
            self.save(row)
        if row["state"] == "recording":
            if key != self.active:
                row.update(state="failed", note="The helper ended before confirming this recording.")
            else:
                path = self.path(key, ".bin")
                size = path.stat().st_size if path.exists() else 0
                factor = 2 if row["rate"] == RATES[-1] else 1
                row["samples"] = self.loop_sink.total * factor if self.loop_sink else min(row["limit"], size * factor)
        return row

    def stop(self, key):
        self.refresh()
        if key == self.active and self.process:
            self.process.stdin.close()
        return self.status(key)

    def window(self, key, start, end, *, preview=False, analysis=False):
        row = self.status(key)
        readable = row["state"] == "saved" or (preview and row["state"] == "recording" and key == self.active)
        if not readable or type(start) is not int or type(end) is not int or not (
                0 <= start < end <= row["samples"] and end - start <= (1024 * 1024 if analysis else WINDOW)):
            raise ValueError("Invalid recording window")
        return self.read_samples(row, start, end)

    def read_samples(self, row, start, end):
        packed = row["rate"] == RATES[-1]
        start += row.get("firstSample", 0)
        end += row.get("firstSample", 0)
        begin, finish = (start // 2, (end + 1) // 2) if packed else (start, end)
        ring = self.loop_sink if row.get("loop") and row["id"] == self.active else None
        with (ring.lock if ring else nullcontext()):
            if ring and start < max(0, ring.total * (2 if packed else 1) - row["limit"]):
                raise ValueError("Live loop window has advanced")
            memory = self.ram_loops.get(row["id"])
            with (nullcontext(memory) if memory is not None else self.path(row["id"], ".bin").open("rb")) as stream:
                size = finish - begin
                if row.get("loop"):
                    capacity = (row["limit"] + 1) // 2 if packed else row["limit"]
                    pos = begin % capacity
                    stream.seek(pos)
                    first = min(size, capacity - pos)
                    data = stream.read(first)
                    if first < size:
                        stream.seek(0)
                        data += stream.read(size - first)
                else:
                    stream.seek(begin)
                    data = stream.read(size)
        if len(data) != finish - begin:
            raise ValueError("Recording was truncated")
        if packed:
            expanded = bytearray(2 * len(data))
            expanded[::2] = data.translate(LOW_NIBBLE)
            expanded[1::2] = data.translate(HIGH_NIBBLE)
            return bytes(expanded[start % 2:start % 2 + end - start])
        return data

    def overview(self, key, start):
        row = self.status(key)
        rate = row["rate"]
        stride = 1 << ((rate // 1024).bit_length() - 1)
        if row.get("loop"):
            stride = min(stride, 1 << max(0, (row["limit"] // 256).bit_length() - 1))
            if row["state"] == "saved":
                return dict(record=row, first=0, end=0, stride=stride, bins=[])
        if row["state"] == "failed":
            return dict(record=row, first=0, end=0, stride=stride, bins=[])
        if type(start) is not int or start < 0 or start % stride or start > row["samples"]:
            raise ValueError("Invalid overview cursor")
        end = row["samples"]
        if row["state"] == "recording":
            end -= end % stride
        # Only the newest two seconds can be visible after a tab resumes.
        start = max(start, max(0, end - 2 * rate) // stride * stride)
        packed = rate == RATES[-1]
        factor = 2 if packed else 1
        end = min(end, start + 16 * 1024**2 * factor)
        if row.get("loop"):
            ring = self.loop_sink if key == self.active else None
            with (ring.lock if ring else nullcontext()):
                if ring:
                    row["samples"] = ring.total * factor
                    oldest = max(0, row["samples"] - row["limit"])
                    start = max(start, (oldest + stride - 1) // stride * stride)
                    end = min(row["samples"] // stride * stride, start + 1024**2)
                bins = self.loop_bins(row, start, end, stride)
        else:
            bins = self.activity_range(key, start, end, stride, packed)
        return dict(record=row, first=start, end=end, stride=stride, bins=bins)

    def loop_bins(self, row, start, end, stride):
        data = self.read_samples(row, start, end) if end > start else b""
        return [activity_masks(data[i:i + stride], False, False) for i in range(0, len(data), stride)]

    def activity_range(self, key, start, end, stride, packed):
        bins = []
        factor = 2 if packed else 1
        if end > start:
            with self.path(key, ".bin").open("rb") as stream:
                stream.seek(start // factor)
                for offset in range(start, end, stride):
                    count = min(stride, end - offset)
                    size = (count + factor - 1) // factor
                    data = stream.read(size)
                    if len(data) != size:
                        raise ValueError("Incomplete recording overview")
                    bins.append(activity_masks(data, packed, packed and count % 2))
        return bins

    def overview_detail(self, key, first, end):
        row = self.status(key)
        if row["state"] != "saved" or type(first) is not int or type(end) is not int or not (
                0 <= first < end <= row["samples"] and end - first <= 16 * 1024**2):
            raise ValueError("Invalid saved overview range")
        stride = 1 << max(1, ((end - first) // 2048).bit_length())
        first -= first % stride
        return dict(first=first, end=end, stride=stride,
                    bins=self.loop_bins(row, first, end, stride) if row.get("loop") else self.activity_range(key, first, end, stride, row["rate"] == RATES[-1]))

    def edge(self, key, position, channel, direction):
        row = self.status(key)
        packed = row["rate"] == RATES[-1]
        first = 4 if packed and row["bank"] == "upper" else 0
        if (row["state"] != "saved" or type(position) is not int or not 0 <= position <= row["samples"]
                or type(channel) is not int or not first <= channel < first + (4 if packed else 8)
                or direction not in ("previous", "next")):
            raise ValueError("Invalid edge search")
        forward = direction == "next"
        start = position if forward else max(0, position - EDGE_CHUNK - 1)
        end = min(row["samples"], position + EDGE_CHUNK + 1) if forward else position
        if end - start < 2:
            return dict(match=None, resume=None)
        bit = channel - first
        levels = self.read_samples(row, start, end).translate(bytes((i >> bit) & 1 for i in range(256)))
        other = bytes([1 - levels[0 if forward else -1]])
        i = levels.find(other) if forward else levels.rfind(other)
        match = start + i + (0 if forward else 1) if i >= 0 else None
        resume = (end - 1 if end < row["samples"] else None) if forward else (start + 1 if start else None)
        return dict(match=match, resume=None if match is not None else resume)

    def persist_loop(self, key):
        row = self.status(key)
        if row["state"] != "saved":
            raise ValueError("Stop the recording before saving")
        if not row.get("volatile"):
            return row
        memory = self.ram_loops[key]
        size = min(len(memory), (row["samples"] + 1) // 2 if row["rate"] == RATES[-1] else row["samples"])
        if size > self.available():
            raise ValueError("Insufficient archive space. The recording is still in RAM.")
        dest = self.path(key, ".bin")
        try:
            with dest.open("wb") as stream:
                for start in range(0, size, 1024**2):
                    stream.write(memory[start:min(size, start + 1024**2)])
            row.pop("volatile")
            self.save(row)
        except OSError:
            dest.unlink(missing_ok=True)
            raise
        self.ram_loops.pop(key).close()
        return row

    def remove(self, key):
        self.refresh()
        if key == self.active:
            raise ValueError("Stop the recording before deleting it")
        if key in self.ram_loops:
            self.ram_loops.pop(key).close()
        path = self.path(key, ".record")
        pending = self.path(key, ".removing")
        if path.exists():
            path.replace(pending)
        if pending.exists():
            self.finish_removal(key)

    def finish_removal(self, key):
        for suffix in (".bin", ".log", ".json", ".tmp", ".removing"):
            self.path(key, suffix).unlink(missing_ok=True)

    def board_names(self):
        path = self.directory / ".board-names.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}

    def request(self, body):
        if body.get("op") == "discover":
            from esk_discovery import discover
            boards = discover()
            with self.lock:
                names = self.board_names()
            return [dict(board, alias=names.get(board["id"], "")) for board in boards]
        with self.lock:
            op, key = body.get("op"), body.get("id")
            if op == "name_board":
                name = body.get("name")
                if not isinstance(key, str) or not re.fullmatch("[0-9a-f]{12}", key) or not isinstance(name, str):
                    raise ValueError("Invalid board identity or name")
                name = name.strip()
                if len(name) > 48 or (name and not name.isprintable()):
                    raise ValueError("Use up to 48 printable characters")
                names = self.board_names()
                if name:
                    names[key] = name
                else:
                    names.pop(key, None)
                tmp = self.directory / ".board-names.tmp"
                tmp.write_text(json.dumps(names), encoding="utf-8")
                tmp.replace(self.directory / ".board-names.json")
                return name
            if op == "version":
                digest = hashlib.sha256(self.executable.read_bytes()).hexdigest()
                version = None
                manifest = self.executable.with_suffix(".version.json")
                if manifest.is_file():
                    try:
                        metadata = json.loads(manifest.read_text(encoding="utf-8"))
                        if isinstance(metadata, dict) and metadata.get("sha256") == digest:
                            version = metadata.get("version")
                    except (ValueError, OSError):
                        pass
                return {"version": version, "sha256": digest}
            if op == "start":
                return self.start(body.get("rate"), body.get("bank"), body.get("samples"), body.get("serial"), body.get("loop", False), body.get("ramMiB", 0))
            if op == "save_loop":
                return self.persist_loop(key)
            if op == "stop":
                return self.stop(key)
            if op == "overview":
                return self.overview(key, body.get("start"))
            if op == "overview_detail":
                return self.overview_detail(key, body.get("first"), body.get("end"))
            if op == "status":
                row = self.status(key)
                if "preview_after" in body and row["state"] == "recording":
                    after, advance = body["preview_after"], body.get("advance")
                    if type(after) is not int or after < 0 or type(advance) is not int or advance < 0:
                        raise ValueError("Invalid preview cursor")
                    written = row["samples"]
                    if written > after:
                        end = written if after == 0 else min(written, max(after + advance, written - row["rate"] * 75 // 1000))
                        if end > after:
                            data = self.read_samples(row, max(0, end - WINDOW), end)
                            # The frame header carries the confirmed count and exclusive end as uint64 LE.
                            return written.to_bytes(8, "little") + end.to_bytes(8, "little") + data
                return row
            if op == "delete":
                self.remove(key)
                return {}
            if op == "storage":
                return self.storage()
            if op == "set_quota" and "gib" in body:
                return self.set_quota(body["gib"])
            if op == "list":
                for pending in self.directory.glob("*.removing"):
                    self.finish_removal(pending.stem)
                rows = [self.status(p.stem) for p in self.directory.glob("*.record")]
                for row in rows:
                    path = self.path(row["id"], ".bin")
                    row["bytes"] = path.stat().st_size if path.exists() else 0
                return sorted(rows, key=lambda row: row["title"], reverse=True)
            if op in ("window", "preview", "analysis_window"):
                return self.window(key, body.get("start"), body.get("end"), preview=op == "preview", analysis=op == "analysis_window")
            if op == "edge":
                return self.edge(key, body.get("position"), body.get("channel"), body.get("direction"))
            raise ValueError("Unknown recorder operation")


class Handler(BaseHTTPRequestHandler):
    def send_capture(self, body):
        # Hold the last block until the hardware releases the retained capture.
        # If transfer or cleanup fails after headers, Content-Length stays short.
        started = False
        triggered = body.get("trigger") is not None
        def headers(ticks=None):
            nonlocal started
            self.connection.settimeout(1)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(body["count"] + (9 if triggered else 0)))
            if triggered:
                self.send_header("X-ESK-Armed", "1")
            else:
                self.send_header("X-ESK-Ticks", ticks)
            self.send_header("X-ESK-Rate", str(body["rate"]))
            self.send_header("X-ESK-Format", "raw8")
            self.send_header("X-ESK-Channel-Mask", "255")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            started = True
            if triggered:
                self.wfile.write(b"\x01")

        def check_connection():
            if select.select([self.connection], [], [], 0)[0]:
                raise BrokenPipeError("Viewer closed the capture connection")

        try:
            options = dict(armed=headers, check_connection=check_connection) if triggered else {}
            with self.server.boards.capture(body, **options) as (ticks, chunks, keep_alive):
                if triggered:
                    self.wfile.write(int(ticks).to_bytes(8, "little"))
                else:
                    headers(ticks)
                last = b""
                for chunk in chunks:
                    pending = memoryview(last)
                    progress = time.monotonic()
                    while pending:
                        try:
                            written = self.connection.send(pending)
                        except TimeoutError:
                            if time.monotonic() - progress >= 30:
                                raise
                            keep_alive()
                            continue
                        if not written:
                            raise BrokenPipeError("Viewer disconnected")
                        pending = pending[written:]
                        progress = time.monotonic()
                        keep_alive()
                    last = chunk
            self.connection.settimeout(15)
            self.wfile.write(last)
        except (ValueError, OSError):
            if not started:
                raise
            self.close_connection = True

    def reply(self, status, data, mime):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def local_host(self):
        return self.headers.get("Host") == self.server.authority

    def do_POST(self):
        if not self.local_host() or self.headers.get("Origin") != "http://" + self.server.authority:
            return self.send_error(403)
        if self.path != "/api/native" or self.headers.get_content_type() != "application/json":
            return self.send_error(400)
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 1024:
                raise ValueError("Invalid request length")
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError("Invalid request")
            if isinstance(body.get("op"), str) and body["op"].startswith("lan_"):
                if not self.server.boards:
                    raise ValueError("The packaged LAN adapter is unavailable")
                if body["op"] == "lan_capture":
                    return self.send_capture(body)
                result = self.server.boards.request(body)
            else:
                result = self.server.records.request(body)
        except (ValueError, KeyError, OSError) as exc:
            return self.reply(400, str(exc).encode(), "text/plain; charset=utf-8")
        if isinstance(result, bytes):
            return self.reply(200, result, "application/octet-stream")
        self.reply(200, json.dumps(result).encode(), "application/json")

    def do_GET(self):
        if not self.local_host():
            return self.send_error(403)
        name = unquote(urlsplit(self.path).path).lstrip("/") or "index.html"
        path = (self.server.dist / name).resolve()
        if not path.is_relative_to(self.server.dist) or not path.is_file():
            return self.send_error(404)
        data = path.read_bytes()
        if path == self.server.dist / "index.html":
            lan = b" data-local-board" if self.server.boards else b""
            data = data.replace(b"<head>", b'<head><meta name="esk-native-recorder" content="1" data-overview data-analysis data-loop data-ram-loop data-discovery' + lan + b'>', 1)
        self.reply(200, data, mimetypes.guess_type(path.name)[0] or "application/octet-stream")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recorder", type=Path, required=True)
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--archive-limit-gib", type=int, help="Optional cumulative recording quota in GiB")
    parser.add_argument("--serial")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if args.archive_limit_gib is not None and not 1 <= args.archive_limit_gib <= MAX_QUOTA_GIB:
        parser.error(f"--archive-limit-gib must be between 1 and {MAX_QUOTA_GIB}")
    if os.name != "nt" or not args.recorder.is_file() or not (args.dist / "index.html").is_file():
        parser.error("Requires Windows, xlogic_capture.exe and the built viewer")
    dist, store = args.dist.resolve(), args.store.resolve()
    if store.is_relative_to(dist) or dist.is_relative_to(store):
        parser.error("Choose separate recording and viewer directories")
    import msvcrt
    store.mkdir(parents=True, exist_ok=True)
    with (store / ".recorder.lock").open("a+b") as lock, ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        server.dist = dist
        budget = None if args.archive_limit_gib is None else args.archive_limit_gib * GIB
        server.records = Recordings(store, args.recorder.resolve(), args.serial, budget)
        try:
            from xsdk_xesk import open_tcp
            from esk_local_board import LocalBoards
        except ImportError:
            server.boards = None
        else:
            server.boards = LocalBoards()
        server.authority = f"127.0.0.1:{server.server_port}"
        url = f"http://{server.authority}/"
        print(url, flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            with server.records.lock:
                if server.records.process:
                    server.records.process.stdin.close()
                    server.records.process.wait()
                    server.records.refresh()
                    if server.records.loop_sink:
                        server.records.loop_sink.thread.join()
                        server.records.refresh()


if __name__ == "__main__":
    main()
