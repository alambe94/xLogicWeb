"""Serve xEskWeb and its disk-backed Windows recorder on one loopback origin."""
import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
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
    if row["samples"] == row["limit"]:
        message = "Recording limit reached."
    else:
        message = "Recording stopped."
    if receipt.get("cleanup_reads", {}).get("failed_reads"):
        message += " A USB read failed during Stop."
    return message + " The hardware tail is unverified."


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
        self.lock = threading.RLock()
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

    def start(self, rate, bank, samples, serial=None):
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
        factor = 2 if rate == RATES[-1] else 1
        available = self.available()
        limit = min(available, (2**53 - 1) // factor) if samples is None else (samples + factor - 1) // factor
        if limit < 1 or limit > available:
            raise ValueError("Recording exceeds available capture storage")
        key = uuid.uuid4().hex
        row = dict(id=key, title=datetime.now().isoformat(timespec="seconds"), rate=rate, bank=bank,
                   state="recording", samples=0, limit=samples or limit * factor, note="")
        self.save(row)
        # The CLI needs a deadline. Allow long recordings to reach their byte limit.
        duration = max(86400, (row["limit"] + rate - 1) // rate + 60)
        cmd = [str(self.executable), "--continuous", "--sample-rate", str(rate),
               "--channel-mask", str((15 if bank == "lower" else 240) if factor == 2 else 255),
               "--duration", str(duration), "--record-bytes", str(limit), "--stop-on-stdin-close",
               "--output", str(self.path(key, ".bin")), "--json", str(self.path(key, ".json"))]
        if serial or self.serial:
            cmd += ["--serial", serial or self.serial]
        try:
            with self.path(key, ".log").open("wb") as log:
                self.process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=log, stderr=log,
                                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError:
            row.update(state="failed", note="Could not start the native recorder")
            self.save(row)
            raise
        self.active = key
        return row

    def refresh(self):
        if not self.process or self.process.poll() is None:
            return
        proc, key = self.process, self.active
        proc.stdin.close()
        row = self.metadata(key)
        try:
            size = self.path(key, ".bin").stat().st_size
            receipt = json.loads(self.path(key, ".json").read_text())
            packed = row["rate"] == RATES[-1]
            factor = 2 if packed else 1
            mask = (15 if row["bank"] == "lower" else 240) if packed else 255
            if (proc.returncode or receipt["bytes"] != size or not 0 < size <= (row["limit"] + factor - 1) // factor
                    or receipt["actual_sample_rate"] != row["rate"] or receipt["channel_mask"] != mask):
                raise ValueError("Incomplete acquisition")
            if any(receipt[k] for k in ("overruns", "timing_errors", "ownership_errors", "usb_errors")):
                raise ValueError("Capture integrity check failed")
            cleanup = receipt["cleanup_reads"]
            if not cleanup["drain_completed"] or cleanup["unresolved_reads"]:
                raise ValueError("USB cleanup is incomplete")
            row["samples"] = min(row["limit"], size * factor)
            row["state"] = "saved"
            row["note"] = stop_note(row, receipt)
        except (OSError, KeyError, ValueError) as exc:
            row.update(state="failed", note=f"{exc}. See {key}.log and the capture receipt.")
        self.save(row)
        self.process = self.active = None

    def status(self, key):
        self.refresh()
        row = self.metadata(key)
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
                row["samples"] = min(row["limit"], size * (2 if row["rate"] == RATES[-1] else 1))
        return row

    def stop(self, key):
        self.refresh()
        if key == self.active and self.process:
            self.process.stdin.close()
        return self.status(key)

    def window(self, key, start, end, *, preview=False):
        row = self.status(key)
        readable = row["state"] == "saved" or (preview and row["state"] == "recording" and key == self.active)
        if not readable or type(start) is not int or type(end) is not int or not (
                0 <= start < end <= row["samples"] and end - start <= WINDOW):
            raise ValueError("Invalid recording window")
        return self.read_samples(row, start, end)

    def read_samples(self, row, start, end):
        packed = row["rate"] == RATES[-1]
        begin, finish = (start // 2, (end + 1) // 2) if packed else (start, end)
        with self.path(row["id"], ".bin").open("rb") as stream:
            stream.seek(begin)
            data = stream.read(finish - begin)
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
        bins = self.activity_range(key, start, end, stride, packed)
        return dict(record=row, first=start, end=end, stride=stride, bins=bins)

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
                    bins=self.activity_range(key, first, end, stride, row["rate"] == RATES[-1]))

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

    def remove(self, key):
        self.refresh()
        if key == self.active:
            raise ValueError("Stop the recording before deleting it")
        path = self.path(key, ".record")
        pending = self.path(key, ".removing")
        if path.exists():
            path.replace(pending)
        if pending.exists():
            self.finish_removal(key)

    def finish_removal(self, key):
        for suffix in (".bin", ".log", ".json", ".tmp", ".removing"):
            self.path(key, suffix).unlink(missing_ok=True)

    def request(self, body):
        with self.lock:
            op, key = body.get("op"), body.get("id")
            if op == "start":
                return self.start(body.get("rate"), body.get("bank"), body.get("samples"), body.get("serial"))
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
            if op in ("window", "preview"):
                return self.window(key, body.get("start"), body.get("end"), preview=op == "preview")
            if op == "edge":
                return self.edge(key, body.get("position"), body.get("channel"), body.get("direction"))
            raise ValueError("Unknown recorder operation")


class Handler(BaseHTTPRequestHandler):
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
            data = data.replace(b"<head>", b'<head><meta name="esk-native-recorder" content="1" data-overview>', 1)
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


if __name__ == "__main__":
    main()
