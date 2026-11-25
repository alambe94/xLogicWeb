# SPDX-License-Identifier: GPL-3.0-or-later
import unittest
from threading import Event
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from esk_local_uart import LocalUart


class LocalUartTests(unittest.TestCase):
    def setUp(self):
        sdk = MagicMock()
        errors = SimpleNamespace(UartLineError=type("UartLineError", (ValueError,), {}))
        modules = patch.dict("sys.modules", {"xsdk_xesk": sdk, "xsdk_xesk.runtime_errors": errors})
        modules.start()
        self.addCleanup(modules.stop)
        self.identity = b'A' * 16
        self.selection = ("tcp://192.0.2.1:5555", self.identity)
        self.client = sdk.Device.return_value.__enter__.return_value
        self.catalog = SimpleNamespace(device=SimpleNamespace(firmware_version=0x3000, device_id=self.identity, boot_id=42),
                                       services=[SimpleNamespace(service_id=4, instance_id=0, transports=3, max_request_bytes=1024, max_reply_bytes=1024)])
        self.client.inspect.return_value = self.catalog
        self.port = self.client.uart.return_value.__enter__.return_value
        self.sessions = LocalUart()
        self.open = dict(op="lan_uart_open", boot="42", settings=dict(baud=115200, dataBits=8, stopBits=1, parity=0))

    def test_ownership_sequence_and_retirement(self):
        token = self.sessions.request(self.selection, self.open)
        self.port.configure.assert_called_once_with(115200, data_bits=8, stop_bits=1, parity="none")
        def message(op, seq, **fields):
            return self.sessions.request(self.selection, dict(op="lan_uart_" + op, token=token, boot="42", id=seq, **fields))
        with self.assertRaisesRegex(ValueError, "busy"):
            self.sessions.request(self.selection, self.open)
        message("write", 2, data=[0xa5, 0x55])
        with self.assertRaisesRegex(ValueError, "sequence"):
            message("write", 2, data=[0xa5, 0x55])
        self.port.write.assert_called_once_with(b"\xa5\x55")
        self.port.read.return_value = b"\x01\xff"
        self.assertEqual(message("read", 3, count=116), dict(id=3, status=0, data=[1,255]))
        self.assertEqual(message("close", 4), dict(closed=True))
        self.client.uart.return_value.__exit__.assert_called_once()
        with self.assertRaisesRegex(ValueError, "expired"):
            message("read", 5, count=2)
        next_token = self.sessions.request(self.selection, self.open)
        self.sessions.expire(self.selection, token)
        self.assertIn(self.selection, self.sessions.active)
        with patch("esk_local_uart.time.monotonic", return_value=float("inf")):
            self.sessions.expire(self.selection, next_token)
        self.assertFalse(self.sessions.active)

    def test_capability_and_identity_before_claim(self):
        for field, value in (("firmware_version", 0x2f00), ("device_id", b"B"*16), ("boot_id", 43)):
            with patch.object(self.catalog.device, field, value), self.assertRaisesRegex(ValueError, "Board changed"):
                self.sessions.request(self.selection, self.open)
        with self.assertRaisesRegex(ValueError, "settings"):
            self.sessions.request(self.selection, dict(self.open, settings=dict(self.open["settings"], baud=True)))
        self.client.uart.assert_not_called()

    def test_abandoned_client_releases_its_grant_without_another_request(self):
        retired = Event()
        self.client.uart.return_value.__exit__.side_effect = lambda *_: retired.set()
        with patch.object(self.sessions, "IDLE", .03):
            self.sessions.request(self.selection, self.open)
            self.assertTrue(retired.wait(2))
        self.assertFalse(self.sessions.active)
