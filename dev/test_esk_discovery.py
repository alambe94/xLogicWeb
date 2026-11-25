# SPDX-License-Identifier: GPL-3.0-or-later
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from esk_discovery import SERVICE, parse, read_name
from esk_native import Recordings


class DiscoveryTests(unittest.TestCase):
    def test_compressed_ptr_and_unrelated_transaction(self):
        name = b"".join(bytes([len(label)]) + label for label in SERVICE) + b"\0"
        pointer = b"\xc0\x0c"
        target = b"\x03esk" + pointer
        msg = struct.pack(">6H", 15, 0x8400, 1, 1, 0, 0) + name + struct.pack(">HH", 12, 1)
        msg += pointer + struct.pack(">HHIH", 12, 1, 60, len(target)) + target
        self.assertEqual(list(parse(msg, 15)), [(SERVICE, 12, (b"esk", *SERVICE))])
        self.assertEqual(list(parse(msg, 16)), [])
        with self.assertRaises(ValueError):
            read_name(pointer * 7, 12)

    def test_laptop_nickname_survives_reopen_and_address_change(self):
        identity = "1c63491ad84e"
        with tempfile.TemporaryDirectory() as tmp:
            store = Recordings(Path(tmp), None, None, None)
            store.request(dict(op="name_board", id=identity, name="Lab scope"))
            reopened = Recordings(Path(tmp), None, None, None)
            with patch("esk_discovery.discover", return_value=[dict(id=identity, address="192.0.2.12")]):
                self.assertEqual(reopened.request(dict(op="discover"))[0]["alias"], "Lab scope")
                reopened.request(dict(op="name_board", id=identity, name=""))
                self.assertEqual(store.request(dict(op="discover"))[0]["alias"], "")
            with self.assertRaises(ValueError):
                store.request(dict(op="name_board", id="../board", name="invalid"))
