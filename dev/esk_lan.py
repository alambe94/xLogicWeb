"""Serve a built xLogicWeb viewer and one finite-capture action on a trusted LAN."""

import argparse
import ipaddress
import json
import subprocess
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from urllib.parse import urlsplit

SAMPLES = 65536
RATE = 333333333
CAPTURE = "/api/esk/capture"


def capture(args):
    from hw_lock import HardwareLease

    with HardwareLease(args.board, "xlogicweb", "Finite Ethernet capture", ["ethernet", "logic"]), TemporaryDirectory(dir=args.scratch) as tmp:
        raw = Path(tmp) / "samples.raw"
        command = [sys.executable, str(args.xsdk / "tools/xesk/xeskctl.py"), "logic-capture",
                   args.locator, str(raw), "--rate", str(RATE), "--samples", str(SAMPLES),
                   "--max-bytes", str(SAMPLES), "--expected-device-id", args.device_id, "--json"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=85)
        if result.returncode:
            print(result.stderr.strip(), file=sys.stderr, flush=True)
            raise ValueError("Ethernet capture failed. Check board availability and the bridge log.")
        record = json.loads(result.stdout)
        if (record["samples"], record["sample_rate"], record["bytes"], raw.stat().st_size) != (SAMPLES, RATE, SAMPLES, SAMPLES):
            raise ValueError("Board returned an incomplete capture.")
        return raw.read_bytes(), record["timestamp_ticks"]


class Viewer(SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_GET(self):
        if urlsplit(self.path).path == "/esk.html":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(self.server.page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(self.server.page)
        else:
            super().do_GET()

    def do_POST(self):
        if self.path != CAPTURE:
            return self.send_error(HTTPStatus.NOT_FOUND)
        host = self.server.authority
        if (self.headers.get("Host") != host or self.headers.get("Origin") != "http://" + host
                or self.headers.get("X-ESK-Capture") != "finite"):
            return self.send_error(HTTPStatus.FORBIDDEN)
        if self.headers.get("Content-Length", "0") != "0" or "Transfer-Encoding" in self.headers:
            return self.send_error(HTTPStatus.BAD_REQUEST)
        if not self.server.capture_lock.acquire(blocking=False):
            return self.send_error(HTTPStatus.CONFLICT, "Capture already in progress")
        try:
            data, ticks = capture(self.server.options)
        except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
            print(f"Capture failed: {exc}", file=sys.stderr, flush=True)
            return self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, "ESK capture unavailable")
        finally:
            self.server.capture_lock.release()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-ESK-Ticks", str(ticks))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", type=ipaddress.IPv4Address, required=True)
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--xsdk", type=Path, required=True)
    parser.add_argument("--locator", required=True, help="fixed tcp:// address of the board")
    parser.add_argument("--device-id", required=True, help="expected 32-digit device identity")
    parser.add_argument("--board", required=True, help="canonical xSDK hardware lease name")
    parser.add_argument("--scratch", type=Path, help="directory for the temporary raw capture")
    args = parser.parse_args()
    if args.bind.is_unspecified:
        parser.error("Specify the address of the LAN interface")
    sys.path.insert(0, str(args.xsdk.resolve() / "tools/support"))
    page = (args.dist / "index.html").read_bytes()
    if b"</head>" not in page:
        parser.error("Expected a built viewer index.html")
    with ThreadingHTTPServer((str(args.bind), args.port), partial(Viewer, directory=str(args.dist))) as server:
        server.authority = f"{args.bind}:{server.server_port}"
        server.options = args
        server.capture_lock = Lock()
        server.page = page.replace(b"</head>", b'<meta name="esk-lan-capture" content="finite"></head>', 1)
        print(f"Ethernet capture viewer: http://{server.authority}/esk.html", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
