"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RequireAuth } from "@/components/auth/require-auth";
import { parseStatusCode } from "@/lib/http";
import Link from "next/link";
import { trackEndpointCreated } from "@/lib/analytics";
import { createDashboardEndpoint } from "@/lib/dashboard-api";
import { useSite } from "@/components/providers/site-provider";
import { twoSites, type EndpointSite } from "@/lib/site";
import { EndpointSiteField } from "@/components/dashboard/endpoint-site-field";

export default function NewEndpointPage() {
  return (
    <RequireAuth>
      <NewEndpointForm />
    </RequireAuth>
  );
}

function NewEndpointForm() {
  const router = useRouter();
  const { session } = useAuth();
  const site = useSite();

  const [name, setName] = useState("");
  const [listedOn, setListedOn] = useState<EndpointSite>(site.key);
  const [mockStatus, setMockStatus] = useState("200");
  const [mockBody, setMockBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const accessToken = session?.access_token;
      if (!accessToken) {
        throw new Error("Not authenticated");
      }

      const result = await createDashboardEndpoint(accessToken, {
        name: name || undefined,
        ...(twoSites() ? { site: listedOn } : {}),
        mockResponse: mockBody
          ? {
              status: parseStatusCode(mockStatus, 200),
              body: mockBody,
              headers: {},
            }
          : undefined,
      });

      trackEndpointCreated();
      router.push(`/dashboard?endpoint=${result.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create endpoint");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen">
      <main className="container mx-auto px-4 py-8 max-w-xl">
        <h1 className="text-2xl font-bold mb-6">New endpoint</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="name">Name (optional)</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Webhook"
            />
            <p className="text-sm text-muted-foreground">A friendly name for this endpoint</p>
          </div>

          {twoSites() && <EndpointSiteField value={listedOn} onChange={setListedOn} />}

          <div className="border-strong border-line rounded-lg p-4 space-y-4">
            <h2 className="font-semibold">Mock response (optional)</h2>
            <p className="text-sm text-muted-foreground">
              Configure what this endpoint returns when it receives a webhook
            </p>

            <div className="space-y-2">
              <Label htmlFor="mockStatus">Status code</Label>
              <Input
                id="mockStatus"
                type="number"
                value={mockStatus}
                onChange={(e) => setMockStatus(e.target.value)}
                placeholder="200"
                min={100}
                max={599}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="mockBody">Response body</Label>
              <Textarea
                id="mockBody"
                value={mockBody}
                onChange={(e) => setMockBody(e.target.value)}
                placeholder='{"success": true}'
                rows={4}
              />
            </div>
          </div>

          {error && (
            <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950 p-3 rounded">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <Button type="submit" disabled={isSubmitting || !session?.access_token}>
              {isSubmitting ? "Creating..." : "Create endpoint"}
            </Button>
            <Button type="button" variant="outline" asChild>
              <Link href="/dashboard">Cancel</Link>
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
