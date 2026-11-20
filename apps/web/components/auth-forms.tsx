"use client";

import Link from "next/link";
import { useActionState, useState, type FormEvent, type ReactNode } from "react";
import { signInAction, type SignInState } from "@/app/actions";
import { ApiError, api } from "@/lib/client-api";
import { Button, ErrorText, inputClass } from "./ui";

function Field({
  id,
  label,
  hint,
  ...input
}: {
  id: string;
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">
        {label}
      </label>
      <input
        id={id}
        name={id}
        className={inputClass}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-slate-700">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12"
    >
      <div className="rounded-lg border border-slate-300 bg-white p-6 shadow-sm">
        <h1 className="mb-6 text-2xl font-bold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

const initial: SignInState = { error: null };

export function SignInForm() {
  const [state, action, pending] = useActionState(signInAction, initial);
  return (
    <Card title="Sign in to CollabDocs">
      <form action={action} className="space-y-4">
        <Field id="email" label="Email" type="email" autoComplete="email" required />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
        />
        {state.error ? <ErrorText>{state.error}</ErrorText> : null}
        <Button type="submit" variant="primary" className="w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-6 text-sm text-slate-800">
        New here?{" "}
        <Link href="/register" className="font-medium text-indigo-800 underline">
          Create an account
        </Link>
      </p>
    </Card>
  );
}

export function RegisterForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setPending(true);
    try {
      await api("/api/register", {
        method: "POST",
        body: {
          name: String(form.get("name") ?? "") || undefined,
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        },
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Something went wrong. Try again.");
      setPending(false);
      return;
    }
    // The account exists: sign in with the same credentials. On success the action redirects.
    const result = await signInAction(initial, form);
    if (result.error) {
      setError("Your account was created, but signing in failed. Try the sign-in page.");
      setPending(false);
    }
  }

  return (
    <Card title="Create your account">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          id="name"
          label="Name"
          autoComplete="name"
          maxLength={100}
          hint="Shown next to your cursor."
        />
        <Field id="email" label="Email" type="email" autoComplete="email" required />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          required
          hint="At least 10 characters."
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <Button type="submit" variant="primary" className="w-full" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>
      <p className="mt-6 text-sm text-slate-800">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-indigo-800 underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
