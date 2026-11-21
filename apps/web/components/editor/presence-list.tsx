import type { PresentUser } from "@/lib/collab/presence";

export function PresenceList({ users }: { users: PresentUser[] }) {
  return (
    <ul aria-label="People here now" data-testid="presence-list" className="flex flex-wrap gap-2">
      {users.map((user) => (
        <li
          key={user.id}
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-2.5 py-1 text-sm"
        >
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: user.color }}
          />
          <span>
            {user.name}
            {user.isSelf ? " (you)" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
