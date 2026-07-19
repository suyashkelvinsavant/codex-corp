import { useRef } from "react";

export type ByteVoiceSessionToken = Readonly<{
  sessionKey: string;
  generation: number;
}>;

/**
 * Shared authority for Company and Architect voice lifecycle races.
 * A token becomes stale as soon as another session begins or teardown claims
 * the active key. `claimStop` returns each key at most once.
 */
export class ByteVoiceSessionController {
  private generation = 0;
  private activeSessionKey: string | null = null;

  begin(sessionKey: string): ByteVoiceSessionToken {
    this.generation += 1;
    this.activeSessionKey = sessionKey;
    return { sessionKey, generation: this.generation };
  }

  isCurrent(token: ByteVoiceSessionToken): boolean {
    return (
      token.generation === this.generation &&
      token.sessionKey === this.activeSessionKey
    );
  }

  currentKey(): string | null {
    return this.activeSessionKey;
  }

  claimStop(): string | null {
    const key = this.activeSessionKey;
    if (!key) return null;
    this.generation += 1;
    this.activeSessionKey = null;
    return key;
  }
}

export function useByteVoiceSession(): ByteVoiceSessionController {
  const controller = useRef<ByteVoiceSessionController | null>(null);
  if (!controller.current) controller.current = new ByteVoiceSessionController();
  return controller.current;
}
