export type ReminderPrefs = {
  bills: boolean;
  budget: boolean;
  summary: boolean;
};

export type SetupPatchFields = {
  defaultCurrency?: string;
  locale?: string;
  timezone?: string;
  weekStartsOn?: "monday" | "sunday";
  reminders?: ReminderPrefs;
  setupProgress?: {
    currency?: boolean;
    firstAccount?: boolean;
    opening?: boolean;
    categories?: boolean;
    firstTransaction?: boolean;
  };
};

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

function reminders(value: unknown): ReminderPrefs | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.bills !== "boolean" || typeof row.budget !== "boolean" || typeof row.summary !== "boolean") {
    return undefined;
  }
  return { bills: row.bills, budget: row.budget, summary: row.summary };
}

function flag(source: Record<string, unknown>, key: string): boolean | undefined {
  return typeof source[key] === "boolean" ? source[key] : undefined;
}

export function readSetupPatch(body: unknown): SetupPatchFields {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const locale = text(record.locale, 12);
  const currency = text(record.defaultCurrency, 8);
  const timezone = text(record.timezone, 64);
  const rawProgress = record.setupProgress && typeof record.setupProgress === "object" ? (record.setupProgress as Record<string, unknown>) : {};
  const setupProgress = {
    ...(flag(rawProgress, "currency") !== undefined ? { currency: flag(rawProgress, "currency") } : {}),
    ...(flag(rawProgress, "firstAccount") !== undefined ? { firstAccount: flag(rawProgress, "firstAccount") } : {}),
    ...(flag(rawProgress, "opening") !== undefined ? { opening: flag(rawProgress, "opening") } : {}),
    ...(flag(rawProgress, "categories") !== undefined ? { categories: flag(rawProgress, "categories") } : {}),
    ...(flag(rawProgress, "firstTransaction") !== undefined ? { firstTransaction: flag(rawProgress, "firstTransaction") } : {}),
  };
  const chosenReminders = reminders(record.reminders);
  return {
    ...(currency ? { defaultCurrency: currency } : {}),
    ...(locale && /^[a-z]{2}-[A-Z]{2}$/.test(locale) ? { locale } : {}),
    ...(timezone ? { timezone } : {}),
    ...(record.weekStartsOn === "sunday" || record.weekStartsOn === "monday" ? { weekStartsOn: record.weekStartsOn } : {}),
    ...(chosenReminders ? { reminders: chosenReminders } : {}),
    ...(Object.keys(setupProgress).length > 0 ? { setupProgress } : {}),
  };
}
