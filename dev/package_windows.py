# SPDX-License-Identifier: GPL-3.0-or-later
"""Package a root-base production viewer, xlogic_capture.exe, its notices
and the official Windows x64 CPython embeddable ZIP. The output directory
receives xEskWeb-Windows-x64.zip and SHA256SUMS.txt.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recorder-version", help="Release version of the supplied recorder executable")
    for name in ("dist", "recorder", "runtime-zip", "recorder-notices", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    for entry in ("index.html", "sw.js", "LICENSE.txt", "THIRD_PARTY_LICENSES.txt"):
        if not (args.dist / entry).is_file():
            parser.error("Missing production asset " + entry)
    if not (args.recorder_notices / "LICENSE.txt").is_file():
        parser.error("Missing recorder LICENSE.txt")
    args.output.mkdir(parents=True, exist_ok=True)
    target = args.output / "xEskWeb-Windows-x64.zip"
    partial = target.with_suffix(".partial")
    try:
        with ZipFile(partial, "w", ZIP_DEFLATED) as out, ZipFile(args.runtime_zip) as runtime:
            if not {"python.exe", "pythonw.exe", "LICENSE.txt"} <= set(runtime.namelist()):
                parser.error("Expected the official Windows embeddable Python ZIP")
            for entry in runtime.namelist():
                if not entry or PurePosixPath(entry).name != entry or "\\" in entry or ":" in entry:
                    parser.error("Unexpected path in Python runtime")
                out.writestr("runtime/" + entry, runtime.read(entry))
            for file in sorted(args.dist.rglob("*")):
                if file.is_file():
                    out.write(file, "dist/" + file.relative_to(args.dist).as_posix())
            for notice in sorted(args.recorder_notices.glob("*.txt")):
                out.write(notice, "licenses/recorder/" + notice.name)
            for name in ("README.md", "NOTICE.md", "LICENSE"):
                out.write(root / name, name)
            for name in ("Start xEskWeb.cmd", "esk_native.py"):
                out.write(root / "dev" / name, name)
            out.write(root / "dev/esk_discovery.py", "runtime/esk_discovery.py")
            recorder = args.recorder.read_bytes()
            out.writestr("xlogic_capture.exe", recorder)
            if args.recorder_version:
                out.writestr("xlogic_capture.version.json", json.dumps({
                    "version": args.recorder_version, "sha256": hashlib.sha256(recorder).hexdigest(),
                }))
        with ZipFile(partial) as archive:
            if archive.testzip():
                raise ValueError("ZIP verification failed")
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    (args.output / "SHA256SUMS.txt").write_bytes(f"{digest}  {target.name}\n".encode("ascii"))


if __name__ == "__main__":
    main()
