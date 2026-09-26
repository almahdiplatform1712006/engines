/** Where "now" comes from, so expiry can be tested with a fake clock. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
