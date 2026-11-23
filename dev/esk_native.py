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
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


RATES = (41666666, 83333333, 166666666, 333333333, 500000000)
WINDOW = 65536
GIB = 1024 ** 3


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
        self.budget = budget
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
        used = sum(p.stat().st_size for p in self.directory.iterdir() if p.is_file())
        return max(0, min(self.budget - used, shutil.disk_usage(self.directory).free) - 2**20)

    def start(self, rate, bank, samples):
        self.refresh()
        if self.process:
            raise ValueError("Another native recording is active")
        if type(rate) is not int or rate not in RATES or bank not in ("lower", "upper"):
            raise ValueError("Unsupported USB profile")
        if samples is not None and (type(samples) is not int or not 0 < samples < 2**53):
            raise ValueError("Invalid sample count")
        factor = 2 if rate == RATES[-1] else 1
        available = self.available()
        limit = available if samples is None else (samples + factor - 1) // factor
        if limit < 1 or limit > available:
            raise ValueError("Recording exceeds available capture storage")
        key = uuid.uuid4().hex
        row = dict(id=key, title=datetime.now().isoformat(timespec="seconds"), rate=rate, bank=bank,
                   state="recording", samples=0, limit=samples or limit * factor, note="")
        self.save(row)
        cmd = [str(self.executable), "--continuous", "--sample-rate", str(rate),
               "--channel-mask", str((15 if bank == "lower" else 240) if factor == 2 else 255),
               "--duration", "86400", "--record-bytes", str(limit), "--stop-on-stdin-close",
               "--output", str(self.path(key, ".bin")), "--json", str(self.path(key, ".json"))]
        if self.serial:
            cmd += ["--serial", self.serial]
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

    def window(self, key, start, end):
        row = self.status(key)
        if row["state"] != "saved" or type(start) is not int or type(end) is not int or not (
                0 <= start < end <= row["samples"] and end - start <= WINDOW):
            raise ValueError("Invalid recording window")
        packed = row["rate"] == RATES[-1]
        begin, finish = (start // 2, (end + 1) // 2) if packed else (start, end)
        with self.path(key, ".bin").open("rb") as stream:
            stream.seek(begin)
            data = stream.read(finish - begin)
        if len(data) != finish - begin:
            raise ValueError("Recording was truncated")
        if packed:
            return bytes((data[i // 2 - begin] >> (4 * (i % 2))) & 15 for i in range(start, end))
        return data

    def request(self, body):
        with self.lock:
            op, key = body.get("op"), body.get("id")
            if op == "start":
                return self.start(body.get("rate"), body.get("bank"), body.get("samples"))
            if op == "stop":
                return self.stop(key)
            if op == "status":
                return self.status(key)
            if op == "list":
                rows = [self.status(p.stem) for p in self.directory.glob("*.record")]
                return sorted(rows, key=lambda row: row["title"], reverse=True)
            if op == "window":
                return self.window(key, body.get("start"), body.get("end"))
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
            data = data.replace(b"<head>", b'<head><meta name="esk-native-recorder" content="1">', 1)
        self.reply(200, data, mimetypes.guess_type(path.name)[0] or "application/octet-stream")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recorder", type=Path, required=True)
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--serial")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
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
        server.records = Recordings(store, args.recorder.resolve(), args.serial, 16 * GIB)
        server.authority = f"127.0.0.1:{server.server_port}"
        url = f"http://{server.authority}/?view=logic"
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
