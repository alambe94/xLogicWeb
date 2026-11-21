"""Exercise the Wi-Fi capture boundary without a board."""
import http.client
import threading
import unittest
from unittest.mock import patch

from esk_lan import CAPTURE, SAMPLES, ThreadingHTTPServer, Viewer


class BridgeTest(unittest.TestCase):
    def setUp(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Viewer)
        server.authority = f"127.0.0.1:{server.server_port}"
        server.options = object()
        server.capture_lock = threading.Lock()
        self.server = server
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)

    def request(self, *, method="POST", path=CAPTURE, origin=None, body=None):
        conn = http.client.HTTPConnection(self.server.authority, timeout=3)
        try:
            conn.request(method, path, body, {"Origin": origin or "http://" + self.server.authority,
                                              "X-ESK-Capture": "finite"})
            response = conn.getresponse()
            return response.status, response.headers, response.read()
        finally:
            conn.close()

    @patch("esk_lan.capture")
    def test_fresh_records_and_recovery(self, capture):
        samples = bytes(range(256)) * (SAMPLES // 256)
        capture.side_effect = [(samples, 101), ValueError("board busy"), (samples, 202)]
        for status, ticks in [(200, "101"), (503, None), (200, "202")]:
            actual, headers, data = self.request()
            self.assertEqual((actual, headers.get("X-ESK-Ticks")), (status, ticks))
            if actual == 200:
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(data, samples)
        self.assertEqual(capture.call_count, 3)

    @patch("esk_lan.capture")
    def test_no_acquisition_on_foreign_origin_busy_or_invalid_request(self, capture):
        self.assertEqual(self.request(origin="http://other.local")[0], 403)
        self.assertEqual(self.request(body=b"extra")[0], 400)
        self.assertEqual(self.request(method="GET")[0], 404)
        self.assertEqual(self.request(path="/api/other")[0], 404)
        with self.server.capture_lock:
            self.assertEqual(self.request()[0], 409)
        capture.assert_not_called()


if __name__ == "__main__":
    unittest.main()
