"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RequireAuth } from "@/components/auth/require-auth";
import Link from "next/link";

export default function NewEndpointPage() {
  return (
    <RequireAuth>
      <NewEndpointForm />
    </RequireAuth>
  );
}

function NewEndpointForm() {
  const router = useRouter();
  const createEndpoint = useMutation(api.endpoints.create);

  const [name, setName] = useState("");
  const [mockStatus, setMockStatus] = useState("200");
  const [mockBody, setMockBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const result = await createEndpoint({
        name: name || undefined,
        mockResponse: mockBody
          ? {
              status: parseInt(mockStatus) || 200,
              body: mockBody,
              headers: {},
            }
          : undefined,
      });

      router.push(`/dashboard?endpoint=${result.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create endpoint");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="container mx-auto px-4 h-16 flex items-center">
          <Link href="/dashboard" className="font-bold text-xl">
            webhooks.cc
          </Link>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-xl">
        <h1 className="text-2xl font-bold mb-6">Create new endpoint</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="name">Name (optional)</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Webhook"
            />
            <p className="text-sm text-muted-foreground">
              A friendly name for this endpoint
            </p>
          </div>

          <div className="border rounded-lg p-4 space-y-4">
            <h2 className="font-semibold">Mock Response (optional)</h2>
            <p className="text-sm text-muted-foreground">
              Configure what this endpoint returns when it receives a webhook
            </p>

            <div className="space-y-2">
              <Label htmlFor="mockStatus">Status Code</Label>
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
              <Label htmlFor="mockBody">Response Body</Label>
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
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating..." : "Create Endpoint"}
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
