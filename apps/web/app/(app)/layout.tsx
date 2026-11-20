import Link from "next/link";
import type { ReactNode } from "react";
import { signOutAction } from "@/app/actions";
import { Button } from "@/components/ui";
import { VerificationBanner } from "@/components/verify-email";
import { requirePageUser } from "@/lib/session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requirePageUser();
  return (
    <>
      <header className="border-b border-slate-300 bg-white">
        <nav
          aria-label="Main"
          className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3"
        >
          <Link
            href="/documents"
            className="rounded-md text-lg font-bold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-700"
          >
            CollabDocs
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-slate-800 sm:inline">{user.email}</span>
            <form action={signOutAction}>
              <Button type="submit">Sign out</Button>
            </form>
          </div>
        </nav>
      </header>
      {user.emailVerified ? null : <VerificationBanner email={user.email} />}
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        {children}
      </main>
    </>
  );
}
