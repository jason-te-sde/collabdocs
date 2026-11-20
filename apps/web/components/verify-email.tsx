"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, confirmEmail, resendVerification } from "@/lib/client-api";
import { Button, ErrorText } from "./ui";

/**
 * The page that the emailed link opens. The token is used when the button is
 * pressed, not when the page loads: a mail client that previews links would
 * otherwise use it up.
 */
export function VerifyEmail({ token }: { token: string | null }) {
  const [state, setState] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!token) return;
    setState("working");
    setError(null);
    try {
      await confirmEmail(token);
      setState("done");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Something went wrong. Try again.");
      setState("idle");
    }
  }

  return (
    <main
      id="main"
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12"
    >
      <div className="rounded-lg border border-slate-300 bg-white p-6 shadow-sm">
        <h1 className="mb-4 text-2xl font-bold">Confirm your email address</h1>
        {state === "done" ? (
          <>
            <p role="status" className="text-sm text-slate-900">
              Your email address is confirmed. Invitations sent to it now give you access.
            </p>
            <p className="mt-4 text-sm">
              <Link href="/documents" className="font-medium text-indigo-800 underline">
                Go to your documents
              </Link>
            </p>
          </>
        ) : token ? (
          <>
            <p className="mb-4 text-sm text-slate-900">
              Press the button to confirm that this address is yours.
            </p>
            {error ? <ErrorText>{error}</ErrorText> : null}
            <Button
              variant="primary"
              className="mt-2 w-full"
              disabled={state === "working"}
              onClick={() => void confirm()}
            >
              {state === "working" ? "Confirming…" : "Confirm email address"}
            </Button>
          </>
        ) : (
          <ErrorText>This link is incomplete. Open the link from the email.</ErrorText>
        )}
      </div>
    </main>
  );
}

/** Shown on every page of the app to an account whose address is not confirmed. */
export function VerificationBanner({ email }: { email: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resend() {
    setBusy(true);
    try {
      await resendVerification();
      setMessage("A new link is on its way.");
    } catch (caught) {
      setMessage(caught instanceof ApiError ? caught.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-amber-400 bg-amber-50">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-2 text-sm text-amber-950">
        <p>
          Confirm your email address: we sent a link to <strong>{email}</strong>. Invitations to
          this address are held back until you do.
        </p>
        <Button disabled={busy} onClick={() => void resend()}>
          Send the link again
        </Button>
        {message ? <p role="status">{message}</p> : null}
      </div>
    </div>
  );
}
