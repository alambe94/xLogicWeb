# xLogicWeb

xLogicWeb is the logic analyzer in xEskWeb. Open the Logic instrument to capture
the eight ESK digital inputs, inspect waveforms and decode protocols on your laptop.
The viewer runs in your browser. [Open xEskWeb](https://alambe94.github.io/xLogicWeb/)

The viewer builds on Sipeed SLogicWeb. **Other analyzer** opens the USB chooser for
compatible Sipeed devices. [Upstream project](https://github.com/sipeed/SLogicWeb)

## USB Home and Bridge

On the hosted xEskWeb Home page, choose **Connect via USB** and select the ESK
application device. Home displays its identity, boot ID, firmware and advertised
features. Open **xLogicWeb** for capture or **xBridgeWeb** for active bus tools.
Both use the device selected on Home during this tab session. In Logic, select
**xBridgeWeb** in the toolbar to keep the I²C controls and waveform visible together.
You can read the board ID during a finite USB acquisition.

In xBridgeWeb, **I²C → Read board ID** reads the TI identification record from
the SK-AM64B EEPROM at address 0x51 and displays its board name and revision.
The transfer sets the EEPROM word address to zero and reads 128 bytes.

## ESK xLOGIC over USB

Open xEskWeb directly in Chrome or Edge using HTTPS or localhost. Connect the ESK
application USB cable, open **xLogicWeb**, press **Capture**, and select the board.
Open the **Capture** panel by clicking the capture summary above the channel labels.
Choose the finite USB sample rate (41.67, 83.33, 166.67 or 333.33 MS/s) and the
visible channels (D0–D7). Each acquisition retains all eight inputs for 65,536 samples. Zoom, add decoders or save the trace using the usual viewer controls.
The board can be released or unplugged after the waveform appears.

## ESK xLOGIC over Ethernet

Open the board IP on port 5555, approve the connection on Home, open **xLogicWeb**
and press **Capture**. Each press retrieves a finite Ethernet capture at 333.33 MS/s. For long
USB recordings, open the HTTPS viewer directly and choose **Open → Record live ESK USB**.
After Stop, use the time slider to browse the disk recording.

For the development bridge on a trusted LAN, run the bridge on a computer with the built viewer, Python
and the xSDK host tools. The phone only needs a browser on the same network.

```sh
python dev/esk_lan.py --dist dist --xsdk /path/to/xSDK --bind <host-lan-ip> --locator tcp://<board-ip>:5555 --device-id <board-device-id> --board sk-am64b
```

Open the printed `/esk.html` URL and choose **Open → Capture from ESK Ethernet…**.
Each request acquires a new eight-channel record using the board's TCP service.
The capture title includes the board timestamp in ticks. Acquisition uses the
same finite profile as USB. The bridge releases the board after each request.
Anyone who can open the bridge on the LAN can request a capture.

### Open from the board

On current firmware, open the board IP to see xEskWeb Home in one tab. Select **Connect device** to read its identity and features. Choose **xLogicWeb** and then **Open → Capture from ESK Ethernet…** for a waveform. Returning to Home preserves the capture. The board handles local WebSocket requests and the viewer loads from GitHub Pages. If the viewer is unavailable, reconnect to the Internet and select **Retry**. Firmware with the older **Open xEskWeb** button continues to pair through its launcher tab. For USB, open the hosted viewer directly.

### Board-origin viewer

When the full viewer files are served at the board's numeric HTTP origin, open the viewer with `?esk=board` and choose **Open → Capture from ESK Ethernet…**. It uses the board's existing `/control.mjs` and `/finite.mjs` and its same-origin `/api/capture` WebSocket. Each capture acquires and releases LOGIC/0. The current small firmware dashboard does not include the full viewer files. Opening the public Pages site alone does not enable Ethernet capture against a board IP.

## Record and reopen ESK logic

For live eight-channel recording, open the HTTPS viewer directly in desktop Chrome, enter Logic and select **Open → Record live ESK USB (41.67 MS/s)**. Set an optional recording limit in MiB, select **Record** and choose your xESK device. **Stop** ends acquisition and finishes pending disk writes. The status shows saved samples and the additional samples transmitted at the stop boundary. A storage backlog or device error ends recording and reports the failure. You can reopen the committed prefix.

Open the HTTPS viewer directly, enter Logic and select **Open → Recording from a saved session**. Choose an eight-channel sigrok `.sr` file, optionally set a recording limit in MiB, and select **Record**. Replay follows the file's sample rate and can slow down while browser storage drains. The Logic display shows up to the latest 65,536 samples. **Stop** finishes pending writes.

To inspect saved data, choose the recording, enter a zero-based first sample and select **Reopen**. Close the recording controls to inspect that window in Logic. Recordings occupy local browser storage for this site and profile until you delete them or clear site data. Live USB and Ethernet capture use their existing menu actions.

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
