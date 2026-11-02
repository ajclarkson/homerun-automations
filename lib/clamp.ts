/** Pins a number into [min, max]. Callers pass a finite value; NaN is rejected, not passed on. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) throw new Error('clamp: value is NaN');
  if (min > max) throw new Error(`clamp: min ${min} exceeds max ${max}`);
  return Math.min(Math.max(value, min), max);
}
