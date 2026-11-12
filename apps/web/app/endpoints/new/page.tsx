"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { RequireAuth } from "@/components/auth/require-auth";
import { useSite } from "@/components/providers/site-provider";
import { NewEndpointForm, newEndpointDescription } from "@/components/dashboard/new-endpoint-form";
import { Card } from "@/components/ui/card";

export default function NewEndpointPage() {
  return (
    <RequireAuth>
      <NewEndpoint />
    </RequireAuth>
  );
}

/** The New endpoint dialog's form on a page of its own, for links that open it directly. */
function NewEndpoint() {
  const router = useRouter();
  const mailFirst = useSite().key === "mailhooks";

  return (
    <div className="min-h-screen">
      <main className="container mx-auto px-4 py-8 max-w-xl">
        <Card className="space-y-4">
          <div className="space-y-1.5">
            <h1 className="text-lg font-bold tracking-normal">Create endpoint</h1>
            <p className="text-sm text-muted-foreground">{newEndpointDescription(mailFirst)}</p>
          </div>
          <NewEndpointForm
            onCreated={(slug) => router.push(`/dashboard?endpoint=${slug}`)}
            cancel={
              <Button type="button" variant="outline" raised render={<Link href="/dashboard" />}>
                Cancel
              </Button>
            }
          />
        </Card>
      </main>
    </div>
  );
}
