"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";

export interface SignInState {
  error: string | null;
}

/** Signs in with email and password and goes to the document list. Returns the error to show, if any. */
export async function signInAction(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/documents",
    });
  } catch (error) {
    if (error instanceof AuthError) return { error: "The email or the password is wrong." };
    // The redirect after a successful sign-in is thrown and must go on.
    throw error;
  }
  return { error: null };
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/sign-in" });
}
