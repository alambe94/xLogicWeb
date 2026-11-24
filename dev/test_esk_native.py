import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from esk_native import Recordings, RATES, WINDOW


class RecordingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = Recordings(Path(temp.name), None, None, 2**20 + 4096)
        self.key = "a" * 32

    def complete(self, rate, limit, data, mask, **changes):
        self.store.save(dict(id=self.key, title="Test capture", rate=rate, bank="upper", limit=limit,
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

    def test_overview_counts_a_single_sample_pulse_and_final_partial_bin(self):
        stride = 1 << ((RATES[0] // 1024).bit_length() - 1)
        data = bytearray([2]) * (stride + 3)
        data[stride - 1] |= 128
        self.complete(RATES[0], len(data), data, 255)
        frame = self.store.overview(self.key, 0)
        self.assertEqual((frame["first"], frame["end"], frame["bins"]), (0, len(data), [0x8202, 0x0202]))
        detail = self.store.overview_detail(self.key, stride-2, stride+2)
        self.assertEqual(detail["bins"], [0x8202, 0x0202])

    def test_packed_overview_ignores_the_unwritten_last_nibble(self):
        self.complete(RATES[-1], 5, bytes.fromhex("22a2f2"), 240)
        self.assertEqual(self.store.overview(self.key, 0)["bins"], [0x0a02])
        self.assertEqual(self.store.overview_detail(self.key, 4, 5)["bins"], [0x0202])

    def test_live_overview_advances_only_over_complete_bins(self):
        self.store.save(dict(id=self.key, rate=RATES[0], bank="lower", state="recording", limit=200000, samples=0))
        self.store.active = self.key
        path = self.store.path(self.key, ".bin")
        path.write_bytes(bytes(65535))
        frame = self.store.overview(self.key, 0)
        self.assertEqual(frame["bins"], [0])
        self.assertEqual(self.store.overview(self.key, frame["end"])["bins"], [])
        with path.open("ab") as f:
            f.write(bytes([1]))
        self.assertEqual(self.store.overview(self.key, frame["end"])["bins"], [0x0100])

    @patch("esk_native.subprocess.Popen")
    def test_selected_usb_serial_reaches_native_recorder(self, launch):
        self.store.request(dict(op="start", rate=RATES[0], bank="lower", samples=64, serial="xESK0123"))
        cmd = launch.call_args.args[0]
        self.assertEqual(cmd[cmd.index("--serial") + 1], "xESK0123")

    @patch("esk_native.subprocess.Popen")
    def test_configured_board_mismatch_fails_before_capture(self, launch):
        self.store.serial = "xESK0123"
        with self.assertRaisesRegex(ValueError, "differs"):
            self.store.start(RATES[0], "lower", 64, serial="xESK5678")
        launch.assert_not_called()
        self.assertEqual(list(self.store.directory.iterdir()), [])

    def test_live_preview_is_bounded_to_written_samples(self):
        self.store.save(dict(id=self.key, rate=RATES[-1], bank="upper", state="recording", limit=9, samples=0))
        self.store.active = self.key
        self.store.path(self.key, ".bin").write_bytes(bytes.fromhex("1032"))
        self.assertEqual(self.store.window(self.key, 1, 4, preview=True), bytes([1, 2, 3]))
        frame = dict(op="status", id=self.key, preview_after=0, advance=1)
        self.assertEqual(self.store.request(frame), (4).to_bytes(8, "little") * 2 + bytes([0, 1, 2, 3]))
        frame["preview_after"] = 1
        self.assertEqual(self.store.request(frame), (4).to_bytes(8, "little") + (2).to_bytes(8, "little") + bytes([0, 1]))
        frame["preview_after"] = 4
        self.assertEqual(self.store.request(frame)["samples"], 4)
        with self.assertRaises(ValueError):
            self.store.window(self.key, 1, 5, preview=True)
        with self.assertRaises(ValueError):
            self.store.window(self.key, 0, 4)
        with self.assertRaises(ValueError):
            self.store.remove(self.key)

    @patch("esk_native.EDGE_CHUNK", 3)
    def test_search_crosses_block_and_packed_byte_boundaries(self):
        self.complete(RATES[-1], 7, bytes.fromhex("000010f1"), 240)
        self.assertEqual(self.store.edge(self.key, 0, 4, "next"), dict(match=None, resume=3))
        self.assertEqual(self.store.edge(self.key, 3, 4, "next")["match"], 5)
        self.assertEqual(self.store.edge(self.key, 7, 4, "previous")["match"], 5)
        self.assertIsNone(self.store.edge(self.key, 5, 4, "next")["match"])
        with self.assertRaises(ValueError):
            self.store.edge(self.key, 1, 0, "previous")
        self.complete(RATES[0], 9, bytes([1, 1, 1, 0, 0, 0, 0, 0, 0]), 255)
        cursor = 9
        while cursor is not None:
            result = self.store.edge(self.key, cursor, 0, "previous")
            cursor = result["resume"]
        self.assertEqual(result["match"], 3)

    def test_archive_usage_and_delete(self):
        self.complete(RATES[0], 3, b"abc", 255)
        self.assertEqual(self.store.request(dict(op="list"))[0]["bytes"], 3)
        free = self.store.available()
        self.store.request(dict(op="delete", id=self.key))
        self.assertGreater(self.store.available(), free)
        self.assertEqual(self.store.request(dict(op="list")), [])
        self.assertEqual(list(self.store.directory.iterdir()), [])
        self.store.remove(self.key)

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
