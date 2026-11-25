# SPDX-License-Identifier: GPL-3.0-or-later
import http.client
import json
import threading
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from esk_local_board import HIGH_RATE, HIGH_RATE_MAX, RATES, LocalBoards, capabilities, locator
from esk_native import Handler, ThreadingHTTPServer


class LocalBoardTests(unittest.TestCase):
    def test_high_rate_requires_capable_firmware_and_catalog(self):
        service = SimpleNamespace(service_id=2, instance_id=0, transports=2, flags=64, buffer_bytes=256, max_rate_hz=HIGH_RATE)
        catalog = SimpleNamespace(device=SimpleNamespace(firmware_version=0x2900), services=[service])
        self.assertEqual(capabilities(catalog)[1], RATES)
        catalog.device.firmware_version = 0x2a00
        self.assertEqual(capabilities(catalog)[1], (HIGH_RATE, *RATES))
        service.max_rate_hz = RATES[0]
        self.assertEqual(capabilities(catalog)[1], RATES)
        service.flags = 0
        self.assertEqual(capabilities(catalog)[1], ())

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
        rec.status.return_value = SimpleNamespace(flags=512, timestamp_ticks=123, sample_rate=333333333,
                                                 stored_bytes=128, format=1, channel_mask=255)
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
            service = client.inspect.return_value.services[0]
            service.buffer_bytes, service.max_rate_hz = HIGH_RATE_MAX + 256, HIGH_RATE
            client.inspect.return_value.device.firmware_version = 0x2a00
            high_fields = dict(fields, rate=HIGH_RATE)
            rec.status.return_value.sample_rate, rec.status.return_value.stored_bytes = HIGH_RATE, 192
            rec.chunks.return_value = [SimpleNamespace(data=bytes(range(i, i + 64)), offset=i) for i in (0, 64, 128)]
            rec.finish.side_effect = None
            with boards.capture(high_fields) as (_, blocks, _):
                self.assertEqual(b"".join(blocks), bytes(range(99)))
            lease.logic_finite_start.assert_called_with(HIGH_RATE, 192, max_capture_bytes=192)
            with self.assertRaisesRegex(ValueError, "exceeds available"), boards.capture(dict(high_fields, count=HIGH_RATE_MAX + 1)):
                self.fail("oversized 500 MS/s capture started")
            rec.status.return_value.channel_mask = 15
            with self.assertRaisesRegex(ValueError, "different capture geometry"), boards.capture(high_fields):
                self.fail("packed 4-channel capture reported as raw bytes")
            client.inspect.return_value.device.firmware_version = 0x2900
            with self.assertRaisesRegex(ValueError, "Unsupported Ethernet"), boards.capture(high_fields):
                self.fail("older firmware started a 500 MS/s capture")
            trigger = dict(edge="falling", channel=3)
            client.inspect.return_value.device.firmware_version = 0x2c00
            sdk.Lease.logic_finite_start = lambda *, trigger_kind=0, trigger_channel=0: None
            with self.assertRaisesRegex(ValueError, "Unsupported Ethernet"), boards.capture(dict(high_fields, trigger=trigger)):
                self.fail("trigger offered at 500 MS/s")
            waiting = SimpleNamespace(flags=256)
            ready = SimpleNamespace(flags=512, sample_rate=fields["rate"], format=1, channel_mask=255,
                                    stored_bytes=128, timestamp_ticks=987)
            rec.status.side_effect = [waiting, ready]
            armed = MagicMock()
            triggered = dict(fields, trigger=trigger)
            with boards.capture(triggered, armed=armed) as (ticks, blocks, _):
                self.assertEqual((ticks, b"".join(blocks)), ("987", bytes(range(99))))
            armed.assert_called_once_with()
            lease.logic_finite_start.assert_called_with(fields["rate"],128,max_capture_bytes=128,trigger_kind=2,trigger_channel=3)
            rec.cancel.reset_mock()
            with self.assertRaises(BrokenPipeError), boards.capture(triggered, armed=armed, check_connection=MagicMock(side_effect=BrokenPipeError)):
                self.fail("disconnected viewer remained armed")
            rec.cancel.assert_called_once()


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
                        conn.request("POST", "/api/native", json.dumps(dict(op="lan_capture", count=count, rate=HIGH_RATE)),
                                     {"Origin": origin, "Content-Type": "application/json"})
                        reply = conn.getresponse()
                        if origin.endswith(".local"):
                            self.assertEqual(reply.status, 403)
                        elif count == 6:
                            self.assertEqual((reply.status, reply.getheader("X-ESK-Ticks"), reply.read()), (200, "123", b"abcdef"))
                            self.assertEqual((reply.getheader("X-ESK-Rate"), reply.getheader("X-ESK-Format"),
                                              reply.getheader("X-ESK-Channel-Mask")), (str(HIGH_RATE), "raw8", "255"))
                        else:
                            with self.assertRaises(http.client.IncompleteRead):
                                reply.read()
                    finally:
                        conn.close()
            finally:
                server.shutdown()
                thread.join()
