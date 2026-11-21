"use client";

import { can } from "@collabdocs/shared/permissions";
import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createDocument,
  listDocuments,
  renameDocument,
  type DocumentSummary,
} from "@/lib/client-api";
import { Button, ErrorText, inputClass } from "./ui";

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function DocumentList() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDocuments((await listDocuments()).documents);
      setLoadError(null);
    } catch (error) {
      setLoadError(message(error));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    listDocuments().then(
      ({ documents: loaded }) => {
        if (!cancelled) setDocuments(loaded);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(message(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const { document } = await createDocument(title);
      router.push(`/documents/${document.id}`);
    } catch (error) {
      setCreateError(message(error));
      setCreating(false);
    }
  }

  const mine = documents?.filter((d) => d.role === "owner") ?? [];
  const shared = documents?.filter((d) => d.role !== "owner") ?? [];

  return (
    <div className="space-y-10">
      <h1 className="text-3xl font-bold">Documents</h1>

      <form onSubmit={onCreate} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <label htmlFor="new-title" className="block text-sm font-medium">
            New document title
          </label>
          <input
            id="new-title"
            className={inputClass}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
            placeholder="Meeting notes"
          />
        </div>
        <Button type="submit" variant="primary" disabled={creating}>
          {creating ? "Creating…" : "Create document"}
        </Button>
      </form>
      {createError ? <ErrorText>{createError}</ErrorText> : null}

      {loadError ? <ErrorText>{loadError}</ErrorText> : null}
      {documents === null && !loadError ? (
        <p role="status" className="text-slate-800">
          Loading documents…
        </p>
      ) : null}

      {documents ? (
        <>
          <Section
            heading="My documents"
            empty="You have not created a document yet."
            items={mine}
            onRenamed={load}
          />
          <Section
            heading="Shared with me"
            empty="Nobody has shared a document with you yet."
            items={shared}
            onRenamed={load}
          />
        </>
      ) : null}
    </div>
  );
}

function Section({
  heading,
  empty,
  items,
  onRenamed,
}: {
  heading: string;
  empty: string;
  items: DocumentSummary[];
  onRenamed: () => void;
}) {
  const headingId = `h-${heading.replaceAll(" ", "-").toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-xl font-semibold">
        {heading}
      </h2>
      {items.length === 0 ? (
        <p className="text-slate-800">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-300 rounded-lg border border-slate-300 bg-white">
          {items.map((document) => (
            <li key={document.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <Link
                  href={`/documents/${document.id}`}
                  className="block truncate rounded font-medium text-indigo-800 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-700"
                >
                  {document.title}
                </Link>
                <p className="text-sm text-slate-700">
                  {document.role === "owner"
                    ? "Owner"
                    : document.role === "editor"
                      ? "Can edit"
                      : "Can view"}
                  {" · "}
                  Updated {dateFormat.format(new Date(document.updatedAt))}
                </p>
              </div>
              {can(document.role, "write") ? (
                <RenameDialog document={document} onRenamed={onRenamed} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RenameDialog({
  document,
  onRenamed,
}: {
  document: DocumentSummary;
  onRenamed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(document.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await renameDocument(document.id, title);
      setOpen(false);
      onRenamed();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setTitle(document.title);
          setError(null);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button aria-label={`Rename ${document.title}`}>Rename</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">Rename document</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-slate-700">
            Everyone with access sees the new title.
          </Dialog.Description>
          <form onSubmit={onSubmit} className="mt-4 space-y-4">
            <div className="space-y-1">
              <label htmlFor={`rename-${document.id}`} className="block text-sm font-medium">
                Title
              </label>
              <input
                id={`rename-${document.id}`}
                className={inputClass}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                required
              />
            </div>
            {error ? <ErrorText>{error}</ErrorText> : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
