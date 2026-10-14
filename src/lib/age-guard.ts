export const MIN_MODEL_AGE = 21;

export function isUnderAge(age: number | string | undefined | null): boolean {
  const n = typeof age === 'string' ? parseInt(age, 10) : age;
  return typeof n === 'number' && !isNaN(n) && n < MIN_MODEL_AGE;
}

export function stripUnderAgeClaims(text: string): string {
  return text
    .replace(/\b(18|19|20)\s*(yo|year|years|year-old|years-old)\b/gi, '')
    .replace(/\bteen\b/gi, '')
    .trim();
}