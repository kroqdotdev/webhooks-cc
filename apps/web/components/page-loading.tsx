import { SkipTarget } from "@/components/nav/skip-target";

/** A whole page waiting on a check (the session, a sign-in): the skip link still has its target. */
export function PageLoading() {
  return (
    <>
      <SkipTarget />
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    </>
  );
}
