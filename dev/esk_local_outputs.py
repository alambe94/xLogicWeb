# SPDX-License-Identifier: GPL-3.0-or-later
"""Typed Ethernet GPIO/PWM operations for the packaged loopback viewer."""
from contextlib import ExitStack
from struct import pack, unpack
import time

from esk_local_grants import IdleGrants


def output_routes(catalog):
    if catalog.device.firmware_version < 0x3200:
        return []
    try:
        from xsdk_xesk.service import GPIO_CONFIGURE8, GPIO_WRITE8
    except ImportError:
        # Older team packages can still use the other Ethernet services.
        return []
    if (GPIO_CONFIGURE8, GPIO_WRITE8) != (8, 9):
        return []
    return [dict(serviceId=int(row.service_id), instanceId=row.instance_id)
            for row in catalog.services if row.transports & 2 and (
                (row.service_id == 7 and row.instance_id == 0 and row.max_request_bytes >= 8 and row.max_reply_bytes >= 4)
                or (row.service_id == 12 and row.instance_id in (0, 1)
                    and row.max_request_bytes >= 16 and row.max_reply_bytes >= 24))]


def output_command(port, service, command, payload):
    if (type(command) is not int or not isinstance(payload, list) or len(payload) > 16
            or any(type(b) is not int or not 0 <= b <= 255 for b in payload)):
        raise ValueError("Invalid output command")
    if service == 7 and command in (8, 9) and len(payload) == 8:
        mask, levels = unpack("<II", bytes(payload))
        (port.configure if command == 8 else port.write)(mask, levels)
    elif service == 12 and command == 1 and len(payload) == 16:
        period, a, b, mask = unpack("<IIII", bytes(payload))
        port.configure(period, a, b, mask=mask)
    elif service == 12 and command == 4 and not payload:
        timing = port.timing()
        return list(pack("<IIIII", timing.clock_hz, timing.divider, timing.period_ticks, timing.high_ticks_a, timing.high_ticks_b))
    elif service == 12 and command == 6 and not payload:
        port.start()
    elif command == 7 and not payload:
        port.stop()
    else:
        raise ValueError("Unsupported output command or payload length")
    return []


class LocalOutputs(IdleGrants):
    def open(self, selection, body):
        from xsdk_xesk import Device
        address, identity = selection
        service, instance = body.get("serviceId"), body.get("instanceId")
        if (type(service) is not int or type(instance) is not int or
                (service, instance) not in ((7, 0), (12, 0), (12, 1)) or body.get("deviceId") != identity.hex()):
            raise ValueError("Invalid board or output route")
        key = selection, service, instance
        with self.lock, ExitStack() as stack:
            if key in self.active:
                raise ValueError("Output is busy")
            client = stack.enter_context(Device(address))
            catalog = client.inspect()
            if (catalog.device.device_id != identity or str(catalog.device.boot_id) != body.get("boot") or
                    dict(serviceId=service, instanceId=instance) not in output_routes(catalog)):
                raise ValueError("Board changed or Ethernet output unavailable")
            output = stack.enter_context((client.gpio if service == 7 else client.pwm)(instance))
            return self.remember(key, stack, output=output, boot=body["boot"], sequence=0)

    def request(self, selection, body):
        from xsdk_xesk.runtime_errors import ServiceOperationError
        op = body["op"]
        if op == "lan_outputs_open":
            return self.open(selection, body)
        with self.lock:
            key = next((k for k, v in self.active.items() if k[0] == selection and v["token"] == body.get("token")), None)
            if key is None or self.active[key]["boot"] != body.get("boot"):
                raise ValueError("Output session expired")
            current = self.active[key]
            now = time.monotonic()
            if now - current["last"] >= self.IDLE:
                self.close(key)
                raise ValueError("Output session expired")
            seq = body.get("id")
            if type(seq) is not int or seq != current["sequence"] + 1 or seq > 0xffffffff:
                raise ValueError("Unexpected output sequence")
            current.update(sequence=seq, last=now)
            if op == "lan_outputs_close":
                self.close(key)
                return dict(id=seq, closed=True)
            try:
                if op == "lan_outputs_renew":
                    current["output"].renew()
                    return dict(id=seq, renewed=True)
                if op != "lan_outputs_run":
                    raise ValueError("Invalid output operation")
                data = output_command(current["output"], key[1], body.get("command"), body.get("payload"))
                return dict(id=seq, status=0, data=data)
            except ServiceOperationError as error:
                return dict(id=seq, status=error.status, data=[])
            except Exception:
                self.close(key)
                raise
