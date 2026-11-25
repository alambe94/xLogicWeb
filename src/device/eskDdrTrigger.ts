// SPDX-License-Identifier: GPL-3.0-or-later
export interface DdrEdge {
  edge: 'rising' | 'falling';
  channel: number;
}

export interface DdrTrigger extends DdrEdge {
  onArmed(): void;
}

export function validDdrEdge(value: DdrEdge): boolean {
  return (value.edge === 'rising' || value.edge === 'falling') && Number.isInteger(value.channel) &&
    value.channel >= 0 && value.channel < 8;
}
