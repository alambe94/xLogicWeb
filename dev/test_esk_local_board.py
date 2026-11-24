# SPDX-License-Identifier: GPL-3.0-or-later
import http.client
import json
import threading
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from esk_local_board import LocalBoards, locator
from esk_native import Handler, ThreadingHTTPServer


class LocalBoardTests(unittest.TestCase):
    def test_name_is_resolved_once_and_pinned_to_board_identity(self):
        boards = LocalBoards()
        identity = bytes.fromhex("00112233445566778899aabbccddeeff")
        sdk = MagicMock()
        client = sdk.open_tcp.return_value.__enter__.return_value
        client.inspect.return_value.device.device_id = identity
        endpoint = ("192.168.2.18", 5555)
        with patch.dict("sys.modules", xsdk_xesk=sdk), patch("socket.getaddrinfo", return_value=[(None, None, None, None, endpoint)]) as resolve:
            selected = boards.select(dict(host="bench.local", port=5555, discovered=identity.hex()[-12:]))
            boards.open(dict(board=selected, boot="74"))
            self.assertEqual(resolve.call_count, 1)
            sdk.open_tcp.assert_called_with("tcp://192.168.2.18:5555", expected_device_id=identity, expected_boot_id=74)
            with self.assertRaisesRegex(ValueError, "identity changed"):
                boards.select(dict(host=endpoint[0], port=5555, discovered="00" * 6))
            with self.assertRaisesRegex(ValueError, "Select the board"):
                boards.open(dict(board="another", boot="74"))

    def test_only_private_lan_and_single_label_mdns_are_accepted(self):
        for host, port in (("8.8.8.8", 5555), ("127.0.0.1", 5555), ("lab.example.com", 5555),
                           ("a.b.local", 5555), ("192.168.1.20", True), ("192.168.1.20", 65536)):
            with self.subTest(host=host, port=port), self.assertRaises(ValueError):
                locator(host, port)

    def test_capture_aligns_trims_and_retires(self):
        boards = LocalBoards()
        sdk = MagicMock()
        class CaptureError(ValueError):
            status = 2
        sdk.LogicCaptureError = CaptureError
        client = sdk.open_tcp.return_value.__enter__.return_value
        lease = client.claim.return_value.__enter__.return_value
        rec = lease.logic_finite_start.return_value
        client.inspect.return_value.services = [SimpleNamespace(service_id=2, instance_id=0, transports=2, flags=64, buffer_bytes=128)]
        rec.status.return_value = SimpleNamespace(flags=512, timestamp_ticks=123)
        rec.chunks.return_value = [SimpleNamespace(data=bytes(range(128)), offset=0)]
        rec.finish.side_effect = [CaptureError(), None]
        boards.selections["key"] = ("tcp://192.168.1.20:5555", b"0" * 16)
        fields = dict(board="key", boot="1", count=99, rate=333333333)
        with patch.dict("sys.modules", xsdk_xesk=sdk):
            with boards.capture(fields) as (ticks, blocks, _):
                self.assertEqual((ticks, b"".join(blocks)), ("123", bytes(range(99))))
            lease.logic_finite_start.assert_called_once_with(fields["rate"], 128, max_capture_bytes=128)
            self.assertEqual(rec.finish.call_count, 2)
            with self.assertRaises(BrokenPipeError), boards.capture(fields):
                raise BrokenPipeError()
            rec.cancel.assert_called_once()
            with self.assertRaisesRegex(ValueError, "exceeds available"), boards.capture(dict(fields, count=129)):
                self.fail("oversized capture started")


class LocalHttpTest(unittest.TestCase):
    def test_origin_and_incomplete_capture(self):
        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            server.authority = f"127.0.0.1:{server.server_port}"
            server.boards = MagicMock()
            @contextmanager
            def capture(body):
                yield "123", (b"abc", b"def"), lambda: None
                if body["count"] == 7:
                    raise ValueError("cleanup failed")
            server.boards.capture = capture
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for origin, count in (("http://elsewhere.local", 6), ("http://" + server.authority, 6), ("http://" + server.authority, 7)):
                    conn = http.client.HTTPConnection(server.authority, timeout=3)
                    try:
                        conn.request("POST", "/api/native", json.dumps(dict(op="lan_capture", count=count)),
                                     {"Origin": origin, "Content-Type": "application/json"})
                        reply = conn.getresponse()
                        if origin.endswith(".local"):
                            self.assertEqual(reply.status, 403)
                        elif count == 6:
                            self.assertEqual((reply.status, reply.getheader("X-ESK-Ticks"), reply.read()), (200, "123", b"abcdef"))
                        else:
                            with self.assertRaises(http.client.IncompleteRead):
                                reply.read()
                    finally:
                        conn.close()
            finally:
                server.shutdown()
                thread.join()
