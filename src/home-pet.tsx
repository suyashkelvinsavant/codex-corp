import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { RunRecord } from "./model";
import bytePet from "../assets/pets/byte-spritesheet.webp";

type PetState = "idle" | "running" | "waiting" | "error" | "success";

const PET_ANIMATIONS: Record<PetState, { row: number; frames: number }> = {
  idle: { row: 0, frames: 6 },
  running: { row: 1, frames: 8 },
  waiting: { row: 3, frames: 4 },
  error: { row: 5, frames: 8 },
  success: { row: 8, frames: 6 },
};

const PET_FRAME_INTERVAL_MS = 1000; // 1 FPS

export function HomePet({ running, runHistory, onOpenArchitect }: { running: boolean; runHistory: RunRecord[]; onOpenArchitect: (initialPrompt?: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [reaction, setReaction] = useState<"error" | "success" | null>(null);
  const activeRunId = useRef<string | null>(null);
  const latest = runHistory[0];

  // Only react to a run that Byte actually observed while this home page was
  // mounted. Persisted run history must never put a freshly opened app into an
  // old success/error mood.
  useEffect(() => {
    if (running) {
      activeRunId.current = latest?.id ?? activeRunId.current;
      setReaction(null);
      setAsking(false);
      return;
    }
    if (!activeRunId.current || latest?.id !== activeRunId.current) return;
    if (latest.status === "failed" || latest.status === "interrupted") {
      setReaction("error");
      activeRunId.current = null;
    } else if (latest.status === "completed") {
      setReaction("success");
      activeRunId.current = null;
    }
  }, [latest?.id, latest?.status, running]);

  useEffect(() => {
    if (!reaction) return;
    const reset = window.setTimeout(() => setReaction(null), 6000);
    return () => window.clearTimeout(reset);
  }, [reaction]);

  useEffect(() => {
    if (running || reaction) return;
    const start = window.setTimeout(() => setAsking(true), 9000);
    const stop = window.setTimeout(() => setAsking(false), 15000);
    return () => { clearTimeout(start); clearTimeout(stop); };
  }, [reaction, running]);

  const state: PetState = running
    ? "running"
    : asking
      ? "waiting"
      : reaction ?? "idle";
  const [frame, setFrame] = useState(0);
  const animation = PET_ANIMATIONS[state];
  useEffect(() => {
    setFrame(0);
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % animation.frames), PET_FRAME_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [animation.frames, state]);
  const spriteStyle = {
    "--pet-column": `${(frame / 7) * 100}%`,
    "--pet-row": `${(animation.row / 10) * 100}%`,
    backgroundImage: `url(${bytePet})`,
  } as CSSProperties;
  const copy: Record<PetState, string> = { idle: "Byte is dreaming up workflows…", running: "Byte is on the case!", waiting: "Psst—need a workflow?", error: "Hmm… something tripped me up.", success: "Company mission accomplished!" };
  return <aside className={`home-pet state-${state}`} aria-label={`Byte: ${copy[state]}`}>
    <button className="home-pet-bubble" onClick={() => onOpenArchitect()}>{copy[state]}</button>
    <div className="home-pet-playground">
      <button className="home-pet-character" onClick={() => onOpenArchitect()} aria-label="Open Byte">
        <span className="home-pet-sprite" style={spriteStyle} role="img" aria-label="Byte, a white and pink baby cat wearing headphones and working at a laptop" />
        <span className="home-pet-zzz">z</span>
      </button>
    </div>
  </aside>;
}
