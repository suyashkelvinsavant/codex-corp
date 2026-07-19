import { useEffect, useRef } from "react";
import { PhoneOff } from "lucide-react";
import type { VoiceStore } from "./realtime-voice";

type VoicePanelProps = {
  store: VoiceStore;
  voices: string[];
  onVoiceChange: (voice: string) => void;
  onModalityChange: (modality: "text" | "audio") => void;
  onEnd: () => void;
};

export function VoicePanel({
  store,
  voices,
  onVoiceChange,
  onModalityChange,
  onEnd,
}: VoicePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [store.transcript]);

  return (
    <div className="voice-panel-overlay">
      <div className="voice-panel">
        <div className="voice-panel-header">
          <span className="voice-panel-status">
            {store.state === "live"
              ? "Live"
              : store.state === "starting"
                ? "Connecting…"
                : store.state === "error"
                  ? "Error"
                  : "Voice"}
          </span>
        </div>

        <div className="voice-panel-transcript" ref={scrollRef}>
          {store.transcript.length === 0 && (
            <p className="voice-panel-empty">
              {store.state === "live"
                ? "Speak to begin…"
                : store.state === "starting"
                  ? "Connecting to Codex…"
                  : store.state === "error"
                    ? store.error
                    : ""}
            </p>
          )}
          {store.transcript.map((turn, i) => (
            <div key={i} className={`voice-turn voice-turn-${turn.role}`}>
              <span className="voice-turn-role">
                {turn.role === "user" ? "You" : "Byte"}
              </span>
              <span className="voice-turn-text">{turn.text}</span>
            </div>
          ))}
        </div>

        <div className="voice-panel-controls">
          <label className="voice-panel-label">
            Voice
            <select
              value={store.voice}
              onChange={(e) => onVoiceChange(e.target.value)}
              className="voice-panel-select"
              disabled={store.state === "live"}
              title={
                store.state === "live"
                  ? "Voice is fixed for an active session — end and restart to change"
                  : "Voice for the next session"
              }
            >
              {voices.length === 0 && <option value="">Default</option>}
              {voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>

          <label className="voice-panel-label">
            Output
            <select
              value={store.outputModality}
              onChange={(e) =>
                onModalityChange(e.target.value as "text" | "audio")
              }
              className="voice-panel-select"
              disabled={store.state === "live"}
              title={
                store.state === "live"
                  ? "Modality is fixed for an active session — end and restart to change"
                  : "Output modality for the next session"
              }
            >
              <option value="audio">Audio</option>
              <option value="text">Text</option>
            </select>
          </label>

          <button
            type="button"
            className="agent-tool-btn live voice-panel-end"
            onClick={onEnd}
            title="End voice session"
            aria-label="End voice session"
          >
            <PhoneOff size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
