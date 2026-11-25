# SPDX-License-Identifier: GPL-3.0-or-later
"""Board-specific LAN operations for the packaged loopback viewer."""
from contextlib import contextmanager
from ipaddress import IPv4Address, IPv4Network
from inspect import signature
import re
import socket
from threading import Lock
import time
from uuid import uuid4


NETWORKS = tuple(map(IPv4Network, ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16")))
RATES = (333333333, 166666666, 83333333, 41666666)
HIGH_RATE = 500000000
PRETRIGGER_PERCENTS = (25, 50, 75)
HIGH_RATE_MAX = 2147483520
# The network image expires idle TCP connections after ten seconds.
RENEW_SECONDS = 2
NAMES = ("", "Device", "Logic", "DAP", "UART", "I2C", "SPI", "GPIO", "USB analyzer",
         "BLE analyzer", "Power analyzer", "Firmware update", "PWM", "CAN", "LIN", "RS485", "QSPI")
OWNERS = ("Unknown", "Unclaimed", "Busy (pending)", "Busy (claimed)", "Retiring", "Quarantined", "Faulted")


def locator(host, port):
    if not isinstance(host, str) or type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Enter a board address and port")
    if re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local", host, re.I):
        addresses = {row[4][0] for row in socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)}
        if len(addresses) != 1:
            raise ValueError("The board name must resolve to one LAN address")
        host = addresses.pop()
    ip = IPv4Address(host)
    if not any(ip in network for network in NETWORKS):
        raise ValueError("Choose a board on the lab LAN")
    return f"tcp://{ip}:{port}"


def capabilities(catalog):
    services = {int(s.service_id): s for s in catalog.services if s.instance_id == 0 and s.transports & 2}
    logic, i2c = services.get(2), services.get(5)
    maximum = min(logic.buffer_bytes, 0xffffffc0) // 64 * 64 if logic and logic.flags & 64 else 0
    rates = RATES if maximum else ()
    if maximum >= 192 and catalog.device.firmware_version >= 0x2a00 and logic.max_rate_hz == HIGH_RATE:
        rates = (HIGH_RATE, *rates)
    limits = None
    if i2c and i2c.max_request_bytes >= 7 and i2c.max_reply_bytes:
        size = min(120, i2c.max_request_bytes)
        limits = dict(write=size - 4, writeRead=size - 6, read=min(116, i2c.max_reply_bytes))
    return maximum, rates, limits


def trigger_supported(catalog):
    from xsdk_xesk import Lease
    return catalog.device.firmware_version >= 0x2c00 and "trigger_kind" in signature(Lease.logic_finite_start).parameters


def history_profiles(catalog, maximum, rates):
    from xsdk_xesk import Lease
    version = catalog.device.firmware_version
    if maximum < 1024 or version < 0x2d00 or not trigger_supported(catalog) or "pre_percent" not in signature(Lease.logic_finite_start).parameters:
        return []
    try:
        from xsdk_xesk.network_logic import history_counts
    except ImportError:
        # SDKs built for the 0.45 pilot accept only its original geometry.
        return [dict(rate=41666666, counts=[1024])] if 41666666 in rates else []
    profiles = []
    for rate in rates:
        counts = [n for n in history_counts((version >> 16, version >> 8 & 255, version & 255), rate) if n <= maximum]
        if counts:
            profiles.append(dict(rate=rate, counts=counts))
    return profiles


def status(client):
    catalog = client.inspect()
    device = catalog.device
    maximum, rates, limits = capabilities(catalog)
    history = history_profiles(catalog, maximum, rates)
    management = next((s for s in catalog.services if int(s.service_id) == 1 and not s.instance_id and s.transports & 2), None)
    rows = client.feature_status().rows if management and management.flags & 16 else ()
    services = []
    for s in catalog.services:
        resources = [f"#{r.resource_id}" + (f" (group {r.alternative_group}, option {r.alternative_option})" if r.alternative_group else "")
                     for r in catalog.requirements if (r.service_id, r.instance_id) == (s.service_id, s.instance_id)]
        transports = " + ".join(name for bit, name in ((1, "USB"), (2, "Network")) if s.transports & bit)
        services.append([f"{NAMES[s.service_id]} / {s.instance_id}", transports, f"{s.max_request_bytes} / {s.max_reply_bytes}",
                         ", ".join(resources) or "None", "Read-only"])
    resources = [[f"#{r.resource_id} / {r.resource_type.name.title()}", r.sharing.name.title(), str(r.capacity),
                  f"{r.minimum}..{r.maximum}", r.unit.name.lower()] for r in catalog.resources]
    return dict(deviceId=device.device_id.hex(), boot=str(device.boot_id), firmware=device.firmware_version,
                hardwareId=device.hardware_id, captureMaxSamples=maximum, captureRates=list(rates),
                captureTriggerRates=list(RATES) if maximum and trigger_supported(catalog) else [],
                capturePreTriggerPercents=list(PRETRIGGER_PERCENTS) if history else [], captureHistoryProfiles=history,
                networkManagement=bool(management and device.firmware_version >= 0x2900), i2cLimits=limits,
                features=[dict(name=NAMES[r.feature_id], instance=r.instance_id, enabled=bool(r.capability_flags & 2),
                               ownership=OWNERS[r.ownership]) for r in rows], catalog=dict(services=services, resources=resources))


class LocalBoards:
    def __init__(self):
        self.selections = {}
        self.lock = Lock()

    def select(self, body):
        from xsdk_xesk import open_tcp
        address = locator(body.get("host"), body.get("port"))
        with open_tcp(address) as client:
            identity = client.inspect().device.device_id
            discovered = body.get("discovered")
            if discovered is not None and (not isinstance(discovered, str) or discovered != identity.hex()[-12:]):
                raise ValueError("Discovered board identity changed. Scan again.")
        with self.lock:
            for token, selection in self.selections.items():
                if selection == (address, identity):
                    return token
            if len(self.selections) == 16:
                self.selections.pop(next(iter(self.selections)))
            token = uuid4().hex
            self.selections[token] = (address, identity)
            return token

    def selected(self, body):
        with self.lock:
            selected = self.selections.get(body.get("board")) if isinstance(body.get("board"), str) else None
        if selected is None:
            raise ValueError("Select the board again from Home")
        return selected

    def open(self, body, *, inspect=False):
        from xsdk_xesk import open_tcp
        address, identity = self.selected(body)
        boot = body.get("boot")
        if not inspect and (not isinstance(boot, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", boot)):
            raise ValueError("Refresh the board on Home")
        return open_tcp(address, expected_device_id=identity, expected_boot_id=None if inspect else int(boot))

    def request(self, body):
        op = body["op"]
        if op == "lan_select":
            return self.select(body)
        if op == "lan_i2c":
            from xsdk_xesk import Device
            address, identity = self.selected(body)
            with Device(address) as device:
                state = device.inspect().device
                if state.device_id != identity or str(state.boot_id) != body.get("boot"):
                    raise ValueError("Board changed. Refresh Home.")
                data, count, target = body.get("data"), body.get("count"), body.get("address")
                if (not isinstance(data, list) or len(data) > 116 or type(count) is not int or not 0 <= count <= 116
                        or not (count or data) or any(type(n) is not int or not 0 <= n <= 255 for n in data)):
                    raise ValueError("Invalid I2C transfer")
                with device.i2c() as bus:
                    if not data:
                        return bus.read(target, count)
                    if count:
                        return bus.write_read(target, bytes(data), count)
                    bus.write(target, bytes(data))
                    return b""
        with self.open(body, inspect=op == "lan_status") as client:
            if op == "lan_status":
                return status(client)
            if op == "lan_name":
                if "name" not in body:
                    return dict(name=client.network_settings().hostname)
                saved = client.rename_network_hostname(body["name"])
                return dict(name=saved["hostname"], advertised=saved["advertised_hostname"])
            if op == "lan_restart" and body.get("confirm") is True:
                return client.restart(confirm=True)
            raise ValueError("Unsupported local board operation")

    @contextmanager
    def capture(self, body, *, armed=None, check_connection=None):
        from xsdk_xesk import LogicCaptureError, ServiceId
        count, rate = body.get("count"), body.get("rate")
        if type(count) is not int or count < 1 or type(rate) is not int:
            raise ValueError("Invalid finite capture")
        with self.open(body) as client:
            catalog = client.inspect()
            maximum, rates, _ = capabilities(catalog)
            if rate not in rates:
                raise ValueError("Unsupported Ethernet capture rate")
            quantum = 192 if rate == HIGH_RATE else 64
            size = (count + quantum - 1) // quantum * quantum
            if rate == HIGH_RATE:
                maximum = min(maximum, HIGH_RATE_MAX)
            trigger = body.get("trigger")
            trigger_args = {}
            if trigger is not None:
                if (not isinstance(trigger, dict) or trigger.get("edge") not in ("rising", "falling")
                        or type(trigger.get("channel")) is not int or not 0 <= trigger["channel"] < 8
                        or rate not in RATES or not trigger_supported(catalog)):
                    raise ValueError("Unsupported Ethernet edge trigger")
                trigger_args = dict(trigger_kind=1 if trigger["edge"] == "rising" else 2, trigger_channel=trigger["channel"])
                percent = trigger.get("prePercent", 0)
                if type(percent) is not int or (percent != 0 and (percent not in PRETRIGGER_PERCENTS or
                        not any(profile["rate"] == rate and count in profile["counts"] for profile in history_profiles(catalog, maximum, rates)))):
                    raise ValueError("Unsupported Ethernet pretrigger geometry")
                if percent:
                    trigger_args["pre_percent"] = percent
                    size = count
            if size > maximum:
                raise ValueError("Capture exceeds available board memory")
            with client.claim(ServiceId.LOGIC, lease_ticks=60000) as lease:
                record = lease.logic_finite_start(rate, size, max_capture_bytes=size, **trigger_args)
                renewal = time.monotonic() + RENEW_SECONDS
                deadline = time.monotonic() + size / rate + 5

                def keep_alive():
                    nonlocal renewal
                    if time.monotonic() >= renewal:
                        lease.renew(60000)
                        client.heartbeat()
                        renewal = time.monotonic() + RENEW_SECONDS

                def retire(command):
                    retire_deadline = time.monotonic() + 2
                    while True:
                        try:
                            command()
                            return
                        except LogicCaptureError as exc:
                            if exc.status != 2 or time.monotonic() >= retire_deadline:
                                raise
                            time.sleep(.05)

                def chunks():
                    for block in record.chunks():
                        keep_alive()
                        if block.offset < count:
                            yield block.data[:count - block.offset]

                try:
                    if trigger and armed:
                        armed()
                    while True:
                        if trigger and check_connection:
                            check_connection()
                        keep_alive()
                        result = record.status()
                        if result.flags & 512:
                            break
                        if result.flags & 1024 or (not trigger and time.monotonic() > deadline):
                            raise ValueError("Finite capture did not complete")
                        time.sleep(.03)
                    if (result.sample_rate, result.format, result.channel_mask, result.stored_bytes) != (rate, 1, 255, size):
                        raise ValueError("Board returned a different capture geometry")
                    yield str(result.timestamp_ticks), chunks(), keep_alive
                except (BrokenPipeError, ConnectionResetError, TimeoutError, GeneratorExit):
                    retire(record.cancel)
                    raise
                else:
                    retire(record.finish)

