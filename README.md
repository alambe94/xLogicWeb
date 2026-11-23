# xLogicWeb

xLogicWeb is the logic analyzer in xEskWeb. Open the Logic instrument to capture
the eight ESK digital inputs, inspect waveforms and decode protocols on your laptop.
The viewer runs in your browser. [Open xEskWeb](https://alambe94.github.io/xLogicWeb/)

The viewer builds on Sipeed SLogicWeb. **Other analyzer** opens the USB chooser for
compatible Sipeed devices. [Upstream project](https://github.com/sipeed/SLogicWeb)

## USB Home and Bridge

You can inspect [xBridgeWeb](https://alambe94.github.io/xLogicWeb/?view=bridge)
from any laptop that can open the viewer. Choose a protocol and prepare its command before connecting. To run it,
connect a compatible board over USB on Home in that tab.

On the hosted xEskWeb Home page, choose **Connect via USB** and select the ESK
application device. Home displays its identity, boot ID, firmware and advertised
features. Open **xLogicWeb** for capture or **xBridgeWeb** for active bus tools.
Both use the device selected on Home during this tab session. In Logic, select
**xBridgeWeb** in the toolbar to keep the bus controls and waveform visible together.
You can also choose **Open Logic in a new tab** or **Open Bridge in a new tab** on Home.
Each tab uses its own USB connection. Choose the same board in both tabs.

Run becomes available when the selected board and browser support the chosen protocol.

| Tool | Operation |
| --- | --- |
| I²C | Enter the unshifted 7-bit address in hex, from `0x08` to `0x77` (8–119 decimal). **Write then read** sends a repeated START between the write and read. For a short board-ID check, use address `51`, write `00 00`, and read four bytes. The expected reply is `AA 55 33 EE`. |
| UART | Choose baud, data bits, parity and stop bits, then **Open UART port** and select the serial port belonging to the same board. Enter hex bytes to transmit. The receive display retains the latest 256 bytes. Close the port to release it or change framing. |
| SPI | Select mode and clock. **Transmit and receive** exchanges the entered MOSI bytes for the same number of MISO bytes under one CS0 assertion. **Receive** clocks 1–1,020 bytes using the selected MOSI fill byte (default `00`). For a target that needs a command before returning data, send the command and dummy bytes together using **Transmit and receive**. |
| CAN | Select a nominal bitrate. **Internal loopback** verifies a standard classical CAN frame and its controller echo. **Send frame** and **Listen for one frame** use the external bus and require a transceiver and an active peer. On this USB profile, stop Logic capture before using CAN because channel control also claims interface zero. |

To inspect the EEPROM read on the wires, attach two Logic inputs to SDA and SCL
on that bus and record the channel assignments. On the SK-AM64B demo fixture,
D0 is SCL and D1 is SDA. In Logic, choose USB, 41.67 MS/s, 65,536 samples,
and a falling edge on D1. Click Capture. When Logic is waiting for the edge,
run the four-byte combined read in the Bridge tab. Inspect the finite capture
with the I²C decoder. Select the assigned channels and check the address,
repeated START and four returned bytes. The seven-bit address is `51` in both
directions. The controller ends the last read byte with a NACK and STOP.

## ESK xLOGIC over USB

Open xEskWeb directly in Chrome or Edge using HTTPS or localhost. Connect the ESK
application USB cable, open **xLogicWeb**, press **Capture**, and select the board.
Open the **Capture** panel by clicking the capture summary above the channel labels.
Choose a **Sample rate** and enter the number of **Samples** to retain. The default is
65,536. After each capture you can change either field and capture again in the same tab.
On USB and Ethernet, enter a whole number or use decimal K, M and G suffixes.
For example, `100K` means 100,000 samples and `5G` means 5,000,000,000 samples.
Ethernet counts must fit the capacity advertised by the board.
The viewer remembers your USB selection until the device disconnects or you change it on Home.

At 41.67, 83.33, 166.67 and 333.33 MS/s the board samples all eight inputs.
At 500 MS/s choose D0–D3 (the default) or D4–D7. For longer captures the viewer
saves samples to browser storage and displays a window of the recording. Select
**Until stopped** for an open-ended USB recording. The sustainable rate depends
on the board, USB link and host storage. After Stop, use the slider to browse the trace.

### Native USB recording on Windows

For long laptop captures, download `xEskWeb-Windows-x64.zip` from
[xEskWeb Releases](https://github.com/alambe94/xLogicWeb/releases). Extract it
to a writable folder on an SSD and double-click
`Start xEskWeb.cmd`. The launcher opens xEskWeb Home in your browser. Keep its
console open while recording. For USB, use Chrome or Edge, choose **Connect via
USB**, and select the board once. Logic and Bridge share this selection in the
same tab, including native recordings. Logic also opens saved recordings while
disconnected. For finite Ethernet capture, choose **Connect via Ethernet** and
enter the board address. This opens the board's one-tab viewer and its connection
consent. The board loads that viewer from GitHub Pages.

Choose the rate and sample count in Logic, then press **Capture** once. The waveform opens when the
requested count is reached, or when you press **Stop**. Counts above 65,536 and
**Until stopped** use the native recorder. Choose **Open → Saved recordings…**
to reopen a trace after restarting. The same list includes recordings saved in
this browser profile at this viewer address.

The recorder writes raw samples directly to the SSD. After recording, the viewer
reads up to 65,536 samples at a time as you move the slider. Four-channel captures
store two samples per byte. During capture, **Live preview** shows the latest
written window, refreshed about four times a second while the tab is visible.
A short pulse between preview windows can still be inspected in the saved trace.
Press **Stop** to inspect the recording, select an **Edge channel**, and use
**Previous edge** or **Next edge** to center the waveform on a transition.
The archive has a cumulative 16 GiB limit. **Open → Saved recordings…**
shows free space and each trace's size. Use **Delete recording** to reclaim space.
The timeline reports whether the recorder
verified the hardware end of the stream. With the current SK-AM64B application,
Stop can leave additional samples on the board or in pending USB reads. A
count-limited recording can still contain the full requested sample count.

To launch from source, build the viewer, then run this with Python 3.9 or newer
and a compatible Windows recorder on a machine with the ESK application USB connected.

```powershell
py -3 dev/esk_native.py --dist dist --recorder C:\ESK\xlogic_capture.exe --store D:\ESK\recordings
```

Use `--serial SERIAL` to select a particular board. The hosted viewer continues
to offer WebUSB and Ethernet. The optional PulseView client and sigrok-cli share a Windows ZIP
on the [PulseView fork's releases page](https://github.com/alambe94/pulseview/releases/tag/xsdk-bundle-22).

## ESK xLOGIC over Ethernet

On Home, choose **Connect via Ethernet** and enter the board IP, or open the
board IP directly on port 5555. Connect to the board, open **xLogicWeb**, and
press **Capture**. Ethernet acquires a finite record at 333.33 MS/s. When the board
advertises a capture capacity, enter a sample count or choose **Use board maximum**.
Earlier launchers provide 65,536 samples per capture. Longer records download to
browser storage in blocks.
For continuous recording use the USB connection on the hosted viewer.
After Stop, use the time slider to browse the disk recording.

For the development bridge on a trusted LAN, run the bridge on a computer with the built viewer, Python
and the xSDK host tools. The phone only needs a browser on the same network.

```sh
python dev/esk_lan.py --dist dist --xsdk /path/to/xSDK --bind <host-lan-ip> --locator tcp://<board-ip>:5555 --device-id <board-device-id> --board sk-am64b
```

Open the printed `/esk.html` URL and choose **Capture**.
Each request acquires a new eight-channel record using the board's TCP service.
The capture title includes the board timestamp in ticks. Acquisition uses the
same finite profile as USB. The bridge releases the board after each request.
Anyone who can open the bridge on the LAN can request a capture.

### Open from the board

On current firmware, open the board IP to see xEskWeb Home in one tab. Select **Connect device** to read its identity and features. Choose **xLogicWeb** and then **Capture** for a waveform. Returning to Home preserves the capture. The board handles local WebSocket requests and the viewer loads from GitHub Pages. If the viewer is unavailable, reconnect to the Internet and select **Retry**. Firmware with the older **Open xEskWeb** button continues to pair through its launcher tab. For USB, open the hosted viewer directly.

### Board-origin viewer

When the full viewer files are served at the board's numeric HTTP origin, open the viewer with `?esk=board` and choose **Capture**. It uses the board's existing `/control.mjs` and `/finite.mjs` and its same-origin `/api/capture` WebSocket. Each capture acquires and releases LOGIC/0. The current small firmware dashboard does not include the full viewer files. Opening the public Pages site alone does not enable Ethernet capture against a board IP.

## Record and reopen ESK logic

For live eight-channel recording, open the HTTPS viewer directly in desktop Chrome, enter Logic, choose the rate and sample count or **Until stopped**, press **Capture** and choose your xESK device. **Stop** ends acquisition and finishes pending disk writes. The status shows saved samples and the additional samples transmitted at the stop boundary. A storage backlog or device error ends recording and reports the failure. You can reopen the committed prefix.

Open the HTTPS viewer directly, enter Logic and select **Open → Saved recordings… → Import a .sr session**. Choose an eight-channel sigrok `.sr` file, optionally set a recording limit in MiB, and select **Record**. Replay follows the file's sample rate and can slow down while browser storage drains. The Logic display shows up to the latest 65,536 samples. **Stop** finishes pending writes.

To inspect saved data, choose the recording, enter a zero-based first sample and select **Reopen**. Close the recording controls to inspect that window in Logic. Recordings occupy local browser storage for this site and profile until you delete them or clear site data.

## Features

- Single, Repeat and Loop capture with digital and qualified analog triggers, pre-trigger
  and a conservative, link-aware default rate.
- Analog rows from the ADC module with a declared gain, V/div, autoset and a graticule
  that follows the row height.
- 130+ sigrok decoders (Pyodide), a searchable results list and CSV/TXT export.
- Open `.sr` and `.lwcap`; save `.lwcap`, `.sr`, `.vcd` and `.csv`.
- Installable offline app (service worker), plus a single-file portable build.
- English, 简体中文, Français and Русский.

## Development

```bash
npm install
npm run dev          # http://127.0.0.1:5173/
npm run dev:lan      # HTTPS on the LAN (WebUSB needs a secure context); run `npm run cert` first
npm test             # type-check and every offline self-test
npm run build        # production build into dist/
npm run dist && npm run check:portable   # single-file portable build and its smoke test
```

The product and engineering contracts are in `docs/ARCHITECTURE.md` and `docs/DESIGN.md`;
deployment notes are in `docs/DEPLOY.md`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for third-party
components, including the sigrok decoders.

Copyright (C) 2026 Sipeed Co., Ltd. and contributors.

## Acknowledgements

SLogicWeb grew out of [logicweb](https://github.com/tralamazza/logicweb), the browser logic
analyzer for the SLogic16 U3 written by Daniel Tralamazza. Thank you for the original
design and code.

Protocol decoding uses [sigrok](https://sigrok.org/) decoders, and the device protocol was
cross-checked against the sipeed-slogic-analyzer driver in libsigrok.
