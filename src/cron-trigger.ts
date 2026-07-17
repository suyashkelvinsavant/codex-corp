export type CronMatch = {
  matches: boolean;
  minuteKey: string;
};

export function isValidCronTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone || "UTC" }).format();
    return true;
  } catch {
    return false;
  }
}

function matchesField(value: number, field: string, min: number, max: number) {
  return field.split(",").some((part) => {
    const [base, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let start = min;
    let end = max;
    if (base !== "*") {
      const [startRaw, endRaw] = base.split("-");
      start = Number(startRaw);
      end = endRaw === undefined ? start : Number(endRaw);
    }
    return (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= min &&
      end <= max &&
      start <= end &&
      value >= start &&
      value <= end &&
      (value - start) % step === 0
    );
  });
}

export function matchCron(
  expression: string,
  timezone: string,
  now = new Date(),
): CronMatch {
  const fields = expression.trim().split(/\s+/);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.weekday,
  );
  const minuteKey = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}@${timezone || "UTC"}`;
  if (fields.length !== 5) return { matches: false, minuteKey };
  const values = [
    Number(parts.minute),
    Number(parts.hour),
    Number(parts.day),
    Number(parts.month),
    weekday,
  ];
  const limits = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const;
  return {
    matches: fields.every((field, index) => {
      const [min, max] = limits[index];
      return matchesField(values[index], field, min, max);
    }),
    minuteKey,
  };
}

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const limits = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const;
  return fields.every((field, index) => {
    const [min, max] = limits[index];
    return Array.from(
      { length: max - min + 1 },
      (_, offset) => min + offset,
    ).some((value) => matchesField(value, field, min, max));
  });
}
