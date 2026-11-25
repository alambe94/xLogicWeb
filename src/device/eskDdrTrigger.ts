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
export interface HistoryProfile { rate: number; counts: number[] }

export function ddrHistoryProfiles(firmware: number, capacity: number): HistoryProfile[] {
  if (firmware < 0x2d00 || capacity < 1024) return [];
  const counts = (firmware >= 0x2e00 ? [1024, 100_000, 1_000_000] : [1024]).filter(n => n <= capacity);
  const rates = firmware >= 0x2f00 ? [41_666_666, 83_333_333] : [41_666_666];
  const profiles = rates.map(rate => ({rate, counts}));
  if (firmware >= 0x3100 && capacity >= 100_000) profiles.push({rate: 166_666_666, counts: [100_000]});
  return profiles;
}

export function pretriggerGeometry(rate: number, count: number | undefined, profiles: readonly HistoryProfile[]): boolean {
  return count !== undefined && profiles.some(profile => profile.rate === rate && profile.counts.includes(count));
}

export function validDdrEdge(value: DdrEdge, rate: number, count: number, percents: readonly number[], profiles: readonly HistoryProfile[]): boolean {
  return (value.edge === 'rising' || value.edge === 'falling') && Number.isInteger(value.channel) &&
    value.channel >= 0 && value.channel < 8 && (value.prePercent === undefined || value.prePercent === 0 ||
      (pretriggerGeometry(rate, count, profiles) && DDR_PRETRIGGER_PERCENTS.includes(value.prePercent) && percents.includes(value.prePercent)));
}

export function ddrEdgeRequest({edge, channel, prePercent}: DdrEdge): DdrEdge {
  return prePercent ? {edge, channel, prePercent} : {edge, channel};
}
