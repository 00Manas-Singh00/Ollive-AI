// Hand-rolled 5-field cron validator (minute hour day-of-month month day-of-week).
// No new dependency — BullMQ's repeatable jobs accept a raw cron pattern string,
// so this only needs to reject malformed/too-frequent expressions before they
// reach the scheduler.

const FIELD_RANGES = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function validateField(raw: string, min: number, max: number): boolean {
  if (raw === "*") return true;
  return raw.split(",").every((part) => {
    const [rangePart, stepPart] = part.split("/");
    if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1)) return false;
    if (rangePart === "*") return true;
    const rangeMatch = rangePart.match(/^(\d+)(?:-(\d+))?$/);
    if (!rangeMatch) return false;
    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : start;
    return start >= min && start <= max && end >= min && end <= max && start <= end;
  });
}

/** Validates a strict 5-field cron expression. Returns an error message, or null if valid. */
export function validateCronExpression(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return "Cron expression must have exactly 5 fields: minute hour day-of-month month day-of-week";
  }
  for (let i = 0; i < FIELD_RANGES.length; i += 1) {
    const { name, min, max } = FIELD_RANGES[i];
    if (!validateField(fields[i], min, max)) {
      return `Invalid ${name} field: "${fields[i]}"`;
    }
  }
  // Enforce a minimum 1-hour interval: reject wildcard/step minute fields that would
  // otherwise fire multiple times per hour.
  const minuteField = fields[0];
  if (minuteField.includes("/") || minuteField === "*" || minuteField.includes(",")) {
    return "Minute field must be a single fixed value (minimum interval is 1 hour)";
  }
  return null;
}
