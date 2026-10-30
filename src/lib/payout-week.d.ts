export function manilaParts(instant: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};
export function manilaKey(instant: Date): string;
export function fromManila(year: number, month: number, day: number, hour?: number, minute?: number, second?: number, ms?: number): Date;
export function addCalendarDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number };
export function shiftKey(key: string, days: number): string;
export function formatManilaDate(year: number, month: number, day: number): string;
export function formatManilaInstant(instant: Date): string;
export function payoutFor(now?: Date): {
  start: string;
  end: string;
  payoutMonday: string;
  startKey: string;
  endKey: string;
  label: string;
};
export function inInstantRange(iso: string, startIso: string, endIso: string): boolean;
