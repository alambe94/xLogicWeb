# SPDX-License-Identifier: GPL-3.0-or-later
"""One owned UART grant per loopback viewer session."""
from contextlib import ExitStack
from esk_local_grants import IdleGrants
import time


def uart_limits(catalog):
    service = next((s for s in catalog.services if int(s.service_id) == 4 and not s.instance_id and s.transports & 2), None)
    if catalog.device.firmware_version < 0x3000 or not service or service.max_request_bytes < 8 or service.max_reply_bytes < 1:
        return None
    return dict(write=min(120, service.max_request_bytes), read=min(116, service.max_reply_bytes))


class LocalUart(IdleGrants):
    def open(self, selection, body):
        from xsdk_xesk import Device
        address, identity = selection
        settings = body.get("settings")
        if not isinstance(settings, dict):
            raise ValueError("Invalid UART settings")
        baud, bits, stops, parity = (settings.get(k) for k in ("baud", "dataBits", "stopBits", "parity"))
        if (type(baud) is not int or not 9600 <= baud <= 115200 or type(bits) is not int or bits not in (7, 8)
                or type(stops) is not int or stops not in (1, 2) or type(parity) is not int or parity not in (0, 1, 2)):
            raise ValueError("Invalid UART settings")
        with self.lock, ExitStack() as stack:
            if selection in self.active:
                raise ValueError("UART is busy")
            client = stack.enter_context(Device(address))
            catalog = client.inspect()
            limits = uart_limits(catalog)
            if not limits or catalog.device.device_id != identity or str(catalog.device.boot_id) != body.get("boot"):
                raise ValueError("Board changed or UART unavailable")
            uart = stack.enter_context(client.uart())
            uart.configure(baud, data_bits=bits, stop_bits=stops, parity=("none", "odd", "even")[parity])
            return self.remember(selection, stack, boot=body["boot"], uart=uart, limits=limits, sequence=1)

    def request(self, selection, body):
        from xsdk_xesk.runtime_errors import UartLineError
        if body["op"] == "lan_uart_open":
            return self.open(selection, body)
        with self.lock:
            current = self.active.get(selection)
            if not current or current["token"] != body.get("token") or current["boot"] != body.get("boot"):
                raise ValueError("UART session expired")
            seq = body.get("id")
            if type(seq) is not int or seq != current["sequence"] + 1:
                raise ValueError("Unexpected UART sequence")
            current.update(sequence=seq, last=time.monotonic())
            if body["op"] == "lan_uart_close":
                self.close(selection)
                return dict(closed=True)
            try:
                uart, limits = current["uart"], current["limits"]
                if body["op"] == "lan_uart_write":
                    data = body.get("data")
                    if not isinstance(data, list) or not 0 < len(data) <= limits["write"] or any(type(b) is not int or not 0 <= b <= 255 for b in data):
                        raise ValueError("Invalid UART write")
                    uart.write(bytes(data))
                    return dict(id=seq, status=0, data=[])
                count = body.get("count")
                if body["op"] != "lan_uart_read" or type(count) is not int or not 1 <= count <= limits["read"]:
                    raise ValueError("Invalid UART read")
                return dict(id=seq, status=0, data=list(uart.read(count)))
            except UartLineError as error:
                return dict(id=seq, status=error.status, data=list(error.data))
            except Exception:
                self.close(selection)
                raise
