// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_SAMPLES } from './eskCapture.js';

interface BoardClient {
  connect(): Promise<void>;
  disconnect(): void;
  claim(service: number, ticks: bigint): Promise<void>;
  renew(service: number, ticks: bigint): Promise<unknown>;
  logic(payload: Uint8Array): Promise<unknown>;
  release(service: number): Promise<void>;
  refresh(): Promise<void>;
  readonly sessions: readonly unknown[];
}
type Finite = (
  exchange: (request: Uint8Array) => Promise<unknown>, renew: () => Promise<unknown>,
) => Promise<{ samples: Uint8Array; ticks: bigint }>;

// The firmware supplies the wire decoder for its own API. Always use the page's
// origin for both modules and the socket. A hosted viewer cannot nominate a LAN IP here.
async function boardTransport() {
  const localModule = (path: string) => import(/* @vite-ignore */ new URL(path, location.origin).href);
  const [control, finite] = await Promise.all([localModule('/control.mjs'), localModule('/finite.mjs')]);
  const client: BoardClient = new control.ControlClient(location.origin, { capture: true });
  return { client, acquire: finite.acquireFinite as Finite };
}

let transport: ReturnType<typeof boardTransport> | undefined;
export async function captureBoardOrigin(): Promise<{ samples: Uint8Array; ticks: string }> {
  transport ??= boardTransport().catch(error => { transport = undefined; throw error; });
  const { client, acquire } = await transport;
  const logic = 2;
  const lease = 60000n;
  try {
    await client.connect();
    await client.claim(logic, lease);
    const record = await acquire(request => client.logic(request), () => client.renew(logic, lease));
    if (!(record.samples instanceof Uint8Array) || record.samples.length !== ESK_SAMPLES ||
        typeof record.ticks !== 'bigint') throw new Error('Invalid finite ESK capture');
    await client.release(logic);
    const deadline = performance.now() + 2000;
    while (client.sessions.length) {
      if (performance.now() >= deadline) throw new Error('ESK session retirement deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 40));
      await client.refresh();
      await client.release(logic);
    }
    return { samples: record.samples, ticks: record.ticks.toString() };
  } finally {
    client.disconnect();
  }
}
