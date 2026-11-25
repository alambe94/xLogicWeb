// SPDX-License-Identifier: GPL-3.0-or-later
export interface DdrEdge {
  edge: 'rising' | 'falling';
  channel: number;
  prePercent?: number;
}

export interface DdrTrigger extends DdrEdge {
  onArmed(): void;
}

export const DDR_PRETRIGGER_PERCENTS: readonly number[] = [25, 50, 75];
export function pretriggerGeometry(rate: number, count: number | undefined): boolean {
  return rate === 41_666_666 && count === 1_024;
}

export function validDdrEdge(value: DdrEdge, rate: number, count: number, percents: readonly number[]): boolean {
  return (value.edge === 'rising' || value.edge === 'falling') && Number.isInteger(value.channel) &&
    value.channel >= 0 && value.channel < 8 && (value.prePercent === undefined || value.prePercent === 0 ||
      (pretriggerGeometry(rate, count) && DDR_PRETRIGGER_PERCENTS.includes(value.prePercent) && percents.includes(value.prePercent)));
}

export function ddrEdgeRequest({edge, channel, prePercent}: DdrEdge): DdrEdge {
  return prePercent ? {edge, channel, prePercent} : {edge, channel};
}
