# SPDX-License-Identifier: GPL-3.0-or-later
"""Reap an abandoned viewer's board grant even if no further requests arrive."""
from threading import RLock, Timer
import time
from uuid import uuid4


class IdleGrants:
    IDLE = 5

    def __init__(self):
        self.lock = RLock()
        self.active = {}

    def remember(self, key, stack, **fields):
        token = uuid4().hex
        self.active[key] = dict(token=token, stack=stack.pop_all(), last=time.monotonic(), **fields)
        try:
            self.schedule(key, token, self.IDLE)
        except Exception:
            self.active.pop(key)["stack"].close()
            raise
        return token

    def schedule(self, selection, token, delay):
        timer = Timer(delay, self.expire, args=(selection, token))
        timer.daemon = True
        self.active[selection]["timer"] = timer
        timer.start()

    def close(self, selection):
        current = self.active.pop(selection)
        current["timer"].cancel()
        current["stack"].close()

    def expire(self, selection, token):
        with self.lock:
            current = self.active.get(selection)
            if current and current["token"] == token:
                remaining = self.IDLE - (time.monotonic() - current["last"])
                if remaining > 0:
                    self.schedule(selection, token, remaining)
                else:
                    self.close(selection)
