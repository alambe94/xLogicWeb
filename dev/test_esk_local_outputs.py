# SPDX-License-Identifier: GPL-3.0-or-later
import struct
from threading import Event
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from esk_local_board import LocalBoards
from esk_local_outputs import output_routes


class ServiceError(ValueError):
    status = 0x204006


def words(*values):
    return list(struct.pack("<" + "I" * len(values), *values))


class LocalOutputTests(unittest.TestCase):
    def setUp(self):
        sdk = MagicMock()
        api = SimpleNamespace(GPIO_CONFIGURE8=8, GPIO_WRITE8=9)
        errors = SimpleNamespace(ServiceOperationError=ServiceError)
        modules = patch.dict("sys.modules", {"xsdk_xesk": sdk, "xsdk_xesk.service": api, "xsdk_xesk.runtime_errors": errors})
        modules.start()
        self.addCleanup(modules.stop)
        self.boards = LocalBoards()
        self.identity = bytes(range(16))
        self.selection = ("tcp://192.0.2.1:5555", self.identity)
        self.boards.selections["my-board"] = self.selection
        self.client = sdk.Device.return_value.__enter__.return_value
        self.gpio = self.client.gpio.return_value.__enter__.return_value
        self.pwm = self.client.pwm.return_value.__enter__.return_value
        self.catalog = SimpleNamespace(
            device=SimpleNamespace(firmware_version=0x3200, device_id=self.identity, boot_id=42),
            services=[SimpleNamespace(service_id=s, instance_id=i, transports=2, max_request_bytes=rq, max_reply_bytes=rp)
                      for s, i, rq, rp in [(7, 0, 8, 4), (12, 0, 16, 24), (12, 1, 16, 24)]])
        self.client.inspect.return_value = self.catalog
        self.fields = dict(board="my-board", boot="42")
        self.addCleanup(self.close_remaining)

    def close_remaining(self):
        for key in list(self.boards.outputs.active):
            self.boards.outputs.close(key)

    def open(self, service=7, instance=0, **fields):
        body = dict(self.fields, op="lan_outputs_open", deviceId=self.identity.hex(), serviceId=service, instanceId=instance)
        return self.boards.request(dict(body, **fields))

    def call(self, token, seq, op, **fields):
        return self.boards.request(dict(self.fields, token=token, id=seq, op="lan_outputs_" + op) | fields)

    def test_owned_gpio_holds_and_does_not_replay(self):
        token = self.open()
        with self.assertRaisesRegex(ValueError, "busy"):
            self.open()
        self.call(token, 1, "run", command=8, payload=words(0x90, 0x80))
        self.gpio.configure.assert_called_once_with(0x90, 0x80)
        self.call(token, 2, "run", command=9, payload=words(0x90, 0x10))
        with self.assertRaisesRegex(ValueError, "sequence"):
            self.call(token, 2, "run", command=9, payload=words(0x90, 0x10))
        self.gpio.write.assert_called_once_with(0x90, 0x10)
        self.assertEqual(self.call(token, 3, "renew"), dict(id=3, renewed=True))
        self.gpio.renew.assert_called_once()
        self.call(token, 4, "run", command=7, payload=[])
        self.gpio.stop.assert_called_once()
        self.assertEqual(self.call(token, 5, "close"), dict(id=5, closed=True))
        self.client.gpio.return_value.__exit__.assert_called_once()
        with self.assertRaisesRegex(ValueError, "expired"):
            self.call(token, 6, "renew")

    def test_pwm_instance_and_device_busy_reply(self):
        token = self.open(12, 1)
        self.client.pwm.assert_called_once_with(1)
        self.call(token, 1, "run", command=1, payload=words(1000000, 250, 750, 2))
        self.pwm.configure.assert_called_once_with(1000000, 250, 750, mask=2)
        self.call(token, 2, "run", command=6, payload=[])
        self.pwm.start.assert_called_once()
        self.pwm.timing.return_value = SimpleNamespace(clock_hz=200000000, divider=4, period_ticks=50000,
                                                      high_ticks_a=12500, high_ticks_b=37500)
        self.assertEqual(self.call(token, 3, "run", command=4, payload=[]),
                         dict(id=3, status=0, data=words(200000000, 4, 50000, 12500, 37500)))
        self.call(token, 4, "run", command=7, payload=[])
        self.pwm.stop.assert_called_once()
        other = self.open()
        self.gpio.configure.side_effect = ServiceError()
        self.assertEqual(self.call(other, 1, "run", command=8, payload=words(64, 64)),
                         dict(id=1, status=0x204006, data=[]))
        self.call(other, 2, "close")
        self.call(token, 5, "close")

    def test_route_capabilities_identity_and_boot_before_claim(self):
        self.assertEqual(len(output_routes(self.catalog)), 3)
        for field, value in (("deviceId", "ab"*16), ("boot", "41"), ("instanceId", True)):
            with self.assertRaises(ValueError):
                self.open(**{field: value})
        with patch.object(self.catalog.device, "firmware_version", 0x3100):
            self.assertFalse(output_routes(self.catalog))
        row = self.catalog.services[-1]
        for field, value in (("transports", 1), ("max_request_bytes", 15), ("max_reply_bytes", 23)):
            with patch.object(row, field, value), self.assertRaisesRegex(ValueError, "unavailable"):
                self.open(12, 1)
        self.client.gpio.assert_not_called()
        self.client.pwm.assert_not_called()

    def test_identity_pin_and_failure_do_not_drive_a_second_board(self):
        token = self.open()
        self.boards.selections["other"] = ("tcp://192.0.2.2:5555", self.identity)
        with self.assertRaisesRegex(ValueError, "expired"):
            self.boards.request(dict(board="other", boot="42", token=token, id=1, op="lan_outputs_run", command=8,
                                     payload=words(16, 16)))
        with self.assertRaisesRegex(ValueError, "expired"):
            self.call(token, 1, "run", boot="43", command=8, payload=words(16, 16))
        self.gpio.configure.assert_not_called()
        self.gpio.configure.side_effect = TimeoutError("Delivery uncertain")
        with self.assertRaises(TimeoutError):
            self.call(token, 1, "run", command=8, payload=words(16, 16))
        with self.assertRaisesRegex(ValueError, "expired"):
            self.call(token, 1, "run", command=8, payload=words(16, 16))
        self.gpio.configure.assert_called_once_with(16, 16)

    def test_invalid_frames_release_grant(self):
        for cmd, payload in ((8, [0]), (9, [True]*8), (1, words(1, 1)), (6, []), (True, [])):
            token = self.open()
            with self.assertRaises(ValueError):
                self.call(token, 1, "run", command=cmd, payload=payload)
            self.assertFalse(self.boards.outputs.active)
        self.gpio.configure.assert_not_called()

    def test_idle_output_expires_without_further_requests(self):
        event = Event()
        self.client.gpio.return_value.__exit__.side_effect = lambda *_: event.set()
        with patch.object(self.boards.outputs, "IDLE", .03):
            token = self.open()
            self.assertTrue(event.wait(2))
        with self.assertRaisesRegex(ValueError, "expired"):
            self.call(token, 1, "renew")
