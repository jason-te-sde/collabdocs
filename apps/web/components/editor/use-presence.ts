"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { Awareness } from "y-protocols/awareness";
import { presentUsers, type PresentUser } from "@/lib/collab/presence";

const NONE: PresentUser[] = [];

/** An external store over an awareness map. The snapshot is replaced only when the awareness changes. */
class PresenceStore {
  private current: PresentUser[];

  constructor(private readonly awareness: Awareness) {
    this.current = presentUsers(awareness.getStates(), awareness.clientID);
  }

  subscribe = (listener: () => void): (() => void) => {
    const onChange = () => {
      this.current = presentUsers(this.awareness.getStates(), this.awareness.clientID);
      listener();
    };
    this.awareness.on("change", onChange);
    return () => this.awareness.off("change", onChange);
  };

  getSnapshot = (): PresentUser[] => this.current;
}

/** The people in the awareness map, as a stable array that changes only when the people do. */
export function usePresence(awareness: Awareness): PresentUser[] {
  const store = useMemo(() => new PresenceStore(awareness), [awareness]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => NONE);
}
