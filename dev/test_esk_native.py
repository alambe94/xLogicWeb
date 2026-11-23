import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from esk_native import Recordings, RATES, WINDOW


class RecordingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = Recordings(Path(temp.name), None, None, 2**20 + 4096)
        self.key = "a" * 32

    def complete(self, rate, limit, data, mask, **changes):
        self.store.save(dict(id=self.key, rate=rate, bank="upper", limit=limit,
                             samples=0, state="recording", note=""))
        self.store.path(self.key, ".bin").write_bytes(data)
        receipt = dict(bytes=len(data), actual_sample_rate=rate, channel_mask=mask,
                       overruns=0, timing_errors=0, ownership_errors=0, usb_errors=0,
                       cleanup_reads=dict(drain_completed=True, unresolved_reads=0, failed_reads=1))
        receipt.update(changes)
        self.store.path(self.key, ".json").write_text(json.dumps(receipt))
        self.store.process = Mock(stdin=io.BytesIO(), returncode=0)
        self.store.active = self.key
        return self.store.status(self.key)

    def test_upper_bank_odd_window_and_final_nibble(self):
        row = self.complete(RATES[-1], 5, bytes.fromhex("2143f5"), 240)
        self.assertEqual(row["samples"], 5)
        self.assertIn("tail", row["note"])
        self.assertEqual(self.store.window(self.key, 1, 5), bytes([2, 3, 4, 5]))
        with self.assertRaises(ValueError):
            self.store.window(self.key, 0, 6)

    def test_raw_range(self):
        self.complete(RATES[0], 3, b"abc", 255)
        self.assertEqual(self.store.window(self.key, 1, 3), b"bc")
        with self.assertRaises(ValueError):
            self.store.window(self.key, 0, WINDOW + 1)

    def test_stop_without_failed_reads_still_needs_hardware_proof(self):
        cleanup = dict(drain_completed=True, unresolved_reads=0, failed_reads=0)
        row = self.complete(RATES[0], 9, b"abc", 255, cleanup_reads=cleanup, finish_verified=False)
        self.assertEqual(row["note"], "Recording stopped. The hardware tail is unverified.")
        row["note"] = ""
        self.store.save(row)
        self.assertIn("unverified", self.store.status(self.key)["note"])
        verified = self.complete(RATES[0], 9, b"abc", 255, cleanup_reads=cleanup, finish_verified=True)
        self.assertEqual(verified["note"], "Hardware end of stream verified.")
        limited = self.complete(RATES[0], 3, b"abc", 255, cleanup_reads=cleanup, finish_verified=False)
        self.assertIn("Recording limit reached.", limited["note"])

    def test_receipt_refuses_overrun_and_mismatched_bank(self):
        self.assertEqual(self.complete(RATES[0], 3, b"abc", 255, overruns=1)["state"], "failed")
        self.assertEqual(self.complete(RATES[-1], 5, b"abc", 15)["state"], "failed")
        with self.assertRaises(ValueError):
            self.store.window(self.key, 0, 1)

    def test_quota_and_recording_ids(self):
        with self.assertRaisesRegex(ValueError, "storage"):
            self.store.start(RATES[0], "lower", 4097)
        with self.assertRaisesRegex(ValueError, "ID"):
            self.store.status("../recording")


if __name__ == "__main__":
    unittest.main()
