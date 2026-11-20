import { userColor } from "./identity";

export interface PresentUser {
  id: string;
  name: string;
  color: string;
  isSelf: boolean;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The people in an awareness map, each once (a person with two tabs open has
 * two clients), the local user first. A state without a user, such as a client
 * that has not announced itself yet, is skipped. The color comes from another
 * client, so anything but #rrggbb is replaced.
 */
export function presentUsers(
  states: ReadonlyMap<number, Record<string, unknown>>,
  selfClientId: number,
): PresentUser[] {
  const byId = new Map<string, PresentUser>();
  for (const [clientId, state] of states) {
    const user = state["user"];
    if (typeof user !== "object" || user === null) continue;
    const { id, name, color } = user as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") continue;
    const isSelf = clientId === selfClientId;
    const existing = byId.get(id);
    if (existing && !isSelf) continue;
    byId.set(id, {
      id,
      name,
      color: typeof color === "string" && HEX.test(color) ? color : userColor(id),
      isSelf: isSelf || existing?.isSelf === true,
    });
  }
  return [...byId.values()].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
}
