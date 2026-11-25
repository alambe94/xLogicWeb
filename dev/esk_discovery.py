# SPDX-License-Identifier: GPL-3.0-or-later
"""Browse resident ESK services using bounded, per-interface legacy-unicast mDNS."""
import contextlib
import re
import secrets
import select
import socket
import struct
import time

SERVICE = (b"_xlogic", b"_tcp", b"local")


def read_name(packet, pos):
    labels = []
    end = None
    seen = set()
    length = 1
    while pos not in seen:
        seen.add(pos)
        n = packet[pos]
        if n & 0xc0 == 0xc0:
            if end is None:
                end = pos + 2
            pos = struct.unpack_from(">H", packet, pos)[0] & 0x3fff
        elif n == 0:
            return tuple(labels), end or pos + 1
        else:
            length += n + 1
            if n > 63 or length > 255 or pos + 1 + n > len(packet):
                raise ValueError("Invalid DNS label")
            labels.append(packet[pos + 1:pos + 1 + n].lower())
            pos += n + 1
    raise ValueError("Invalid DNS pointer")


def parse(packet, query_id):
    ident, flags, questions, answers, authorities, extra = struct.unpack_from(">6H", packet)
    if ident != query_id or flags & 0xfa0f != 0x8000 or questions > 4 or answers + authorities + extra > 64:
        return
    pos = 12
    for _ in range(questions):
        _, pos = read_name(packet, pos)
        pos += 4
    for _ in range(answers + authorities + extra):
        name, pos = read_name(packet, pos)
        kind, cls, ttl, size = struct.unpack_from(">HHIH", packet, pos)
        pos += 10
        end = pos + size
        if end > len(packet):
            raise ValueError("Truncated record")
        if cls & 0x7fff == 1 and ttl:
            if kind == 12 or kind == 33 and size > 6:
                target, used = read_name(packet, pos + (6 if kind == 33 else 0))
                if used != end:
                    raise ValueError("Invalid target")
                yield name, kind, target if kind == 12 else (target, struct.unpack_from(">H", packet, pos + 4)[0])
            elif kind == 1 and size == 4:
                yield name, kind, socket.inet_ntoa(packet[pos:end])
            elif kind == 16:
                fields = {}
                while pos < end:
                    n = packet[pos]
                    pos += 1
                    if pos + n > end:
                        raise ValueError("Invalid TXT length")
                    key, sep, value = packet[pos:pos+n].partition(b"=")
                    if sep:
                        fields[key] = value
                    pos += n
                yield name, kind, fields
        pos = end


def discover():
    query_id = secrets.randbelow(65535) + 1
    sockets, found = {}, {}

    def ask(sock, labels, kind):
        q = b"".join(bytes([len(label)]) + label for label in labels) + bytes(1)
        sock.sendto(struct.pack(">6H", query_id, 0, 1, 0, 0, 0) + q + struct.pack(">HH", kind, 1), ("224.0.0.251", 5353))

    with contextlib.ExitStack() as stack:
        addresses = {r[4][0] for r in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
        for ip in sorted(addresses)[:32]:
            try:
                sock = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
                sock.bind((ip, 0))
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(ip))
                ask(sock, SERVICE, 12)
                sockets[sock] = {}, set(), set()
            except OSError:
                continue
        deadline = time.monotonic() + 1.8
        while sockets and (left := deadline - time.monotonic()) > 0:
            for sock in select.select(list(sockets), [], [], left)[0]:
                cache, instances, asked = sockets[sock]
                try:
                    packet, (source, port) = sock.recvfrom(9000)
                    if port != 5353:
                        continue
                    for name, kind, value in list(parse(packet, query_id)):
                        if kind == 12 and name == SERVICE and value[1:] == SERVICE and len(instances) < 64:
                            instances.add((source, value))
                        elif kind in (1, 16, 33) and len(cache) < 256:
                            cache[source, name, kind] = value
                    for peer, instance in instances:
                        if peer != source:
                            continue
                        srv = cache.get((peer, instance, 33))
                        txt = cache.get((peer, instance, 16), {})
                        for labels, kind in [(instance, 33), (instance, 16)] + ([(srv[0], 1)] if srv else []):
                            key = peer, labels, kind
                            if key not in cache and key not in asked and len(asked) < 192:
                                asked.add(key)
                                ask(sock, labels, kind)
                        if not srv or txt.get(b"proto") != b"xesk-control" or txt.get(b"wire") != b"2":
                            continue
                        host, service_port = srv
                        device_id = txt.get(b"id", b"")
                        if (cache.get((peer, host, 1)) != peer or not service_port or len(host) != 2 or host[1] != b"local"
                                or not re.fullmatch(rb"[a-z0-9-]{1,63}", host[0]) or not re.fullmatch(rb"[0-9a-f]{12}", device_id)):
                            continue
                        found[device_id, peer, service_port] = dict(id=device_id.decode(), name=host[0].decode(), address=peer, port=service_port)
                except (ValueError, OSError, IndexError, struct.error):
                    continue
    return sorted(found.values(), key=lambda row: (row["name"], row["address"]))
