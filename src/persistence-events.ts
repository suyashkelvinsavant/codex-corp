export const PERSISTENCE_ERROR_EVENT = "codex-corp:persistence-error";

export type PersistenceErrorDetail = {
  area: string;
  message: string;
};

export function notifyPersistenceError(area: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to persist ${area}`, error);
  try {
    window.dispatchEvent(
      new CustomEvent<PersistenceErrorDetail>(PERSISTENCE_ERROR_EVENT, {
        detail: { area, message },
      }),
    );
  } catch {
    /* non-browser test/runtime */
  }
}
