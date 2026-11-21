"use client";

import {
  ASSIGNABLE_ROLES,
  can,
  isAssignableRole,
  type AssignableRole,
  type Role,
} from "@collabdocs/shared/permissions";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useState, type FormEvent } from "react";
import { Button, ErrorText, inputClass } from "@/components/ui";
import {
  ApiError,
  cancelInvitation,
  changeMemberRole,
  inviteMember,
  listMembers,
  removeMember,
  type Invitation,
  type Member,
} from "@/lib/client-api";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", editor: "Can edit", viewer: "Can view" };

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

function RoleSelect({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: AssignableRole;
  onChange: (role: AssignableRole) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        className={`${inputClass} w-auto`}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          if (isAssignableRole(event.target.value)) onChange(event.target.value);
        }}
      >
        {ASSIGNABLE_ROLES.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABEL[role]}
          </option>
        ))}
      </select>
    </>
  );
}

export function ShareDialog({ documentId, role }: { documentId: string; role: Role }) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AssignableRole>("editor");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const listed = await listMembers(documentId);
      setMembers(listed.memberships);
      setInvitations(listed.invitations);
    } catch (caught) {
      setError(message(caught));
    }
  }, [documentId]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  function onInvite(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await inviteMember(documentId, email, inviteRole);
      setNotice(
        `Invitation sent to ${result.invitation.email}. They get access once they have an account with a confirmed address and open CollabDocs.`,
      );
      setEmail("");
    });
  }

  const canShare = can(role, "share");
  const canManage = can(role, "change-role");

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setNotice(null);
          setError(null);
          void load();
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button>Share</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-6 shadow-xl focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">Share this document</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-slate-700">
            {canShare
              ? "Invite people by email. An invitation waits until the address belongs to a confirmed account."
              : "These people can open this document."}
          </Dialog.Description>

          {canShare ? (
            <form onSubmit={onInvite} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <label htmlFor="invite-email" className="block text-sm font-medium">
                  Email
                </label>
                <input
                  id="invite-email"
                  type="email"
                  className={inputClass}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <span className="block text-sm font-medium" aria-hidden="true">
                  Role
                </span>
                <RoleSelect
                  id="invite-role"
                  label="Role for the new member"
                  value={inviteRole}
                  onChange={setInviteRole}
                />
              </div>
              <Button type="submit" variant="primary" disabled={busy}>
                Invite
              </Button>
            </form>
          ) : null}

          {error ? (
            <div className="mt-3">
              <ErrorText>{error}</ErrorText>
            </div>
          ) : null}
          {notice ? (
            <p role="status" className="mt-3 text-sm text-slate-800">
              {notice}
            </p>
          ) : null}

          <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-700">
            People with access
          </h3>
          {members === null ? (
            <p role="status" className="mt-2 text-sm">
              Loading…
            </p>
          ) : (
            <ul aria-label="People with access" className="mt-2 divide-y divide-slate-200">
              {members.map((member) => {
                const label = member.name ? `${member.name} (${member.email})` : member.email;
                const editable = canManage && member.role !== "owner";
                return (
                  <li key={member.userId} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0 truncate text-sm">{label}</span>
                    <span className="flex items-center gap-2">
                      {editable && isAssignableRole(member.role) ? (
                        <>
                          <RoleSelect
                            id={`role-${member.userId}`}
                            label={`Role for ${member.email}`}
                            value={member.role}
                            disabled={busy}
                            onChange={(next) =>
                              void run(() => changeMemberRole(documentId, member.userId, next))
                            }
                          />
                          <Button
                            variant="danger"
                            disabled={busy}
                            aria-label={`Remove ${member.email}`}
                            onClick={() => void run(() => removeMember(documentId, member.userId))}
                          >
                            Remove
                          </Button>
                        </>
                      ) : (
                        <span className="text-sm text-slate-800">{ROLE_LABEL[member.role]}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {invitations.length > 0 ? (
            <>
              <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-700">
                Waiting for email confirmation
              </h3>
              <ul aria-label="Pending invitations" className="mt-2 divide-y divide-slate-200">
                {invitations.map((invitation) => (
                  <li key={invitation.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0 truncate text-sm">{invitation.email}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-sm text-slate-800">{ROLE_LABEL[invitation.role]}</span>
                      {canManage ? (
                        <Button
                          variant="danger"
                          disabled={busy}
                          aria-label={`Withdraw the invitation for ${invitation.email}`}
                          onClick={() =>
                            void run(() => cancelInvitation(documentId, invitation.id))
                          }
                        >
                          Withdraw
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <div className="mt-6 flex justify-end">
            <Dialog.Close asChild>
              <Button>Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
