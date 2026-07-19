export type PetState = "idle" | "running" | "waiting" | "error" | "success";

export const PET_ANIMATIONS: Record<PetState, { row: number; frames: number }> = {
  idle: { row: 0, frames: 6 },
  running: { row: 1, frames: 8 },
  waiting: { row: 3, frames: 4 },
  error: { row: 5, frames: 8 },
  success: { row: 8, frames: 6 },
};

export const PET_FRAME_INTERVAL_MS = 1000;

export const PET_COPY: Record<PetState, string> = {
  idle: "Byte is dreaming up workflows…",
  running: "Byte is on the case!",
  waiting: "Psst—need a workflow?",
  error: "Hmm… something tripped me up.",
  success: "Company mission accomplished!",
};
