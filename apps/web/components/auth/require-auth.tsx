"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  return (
    <SupabaseAuthProvider>
      <RequireAuthInner>{children}</RequireAuthInner>
    </SupabaseAuthProvider>
  );
}

function RequireAuthInner({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/login");
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
