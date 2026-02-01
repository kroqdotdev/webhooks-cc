"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { useRouter, useParams } from "next/navigation";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { parseStatusCode } from "@/lib/http";
import { copyToClipboard } from "@/lib/clipboard";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import Link from "next/link";
import { Copy, Check } from "lucide-react";

export default function EndpointSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const rawSlug = params.slug;
  const slug = Array.isArray(rawSlug) ? rawSlug[0] : (rawSlug ?? "");

  const endpoint = useQuery(api.endpoints.getBySlug, slug ? { slug } : "skip");
  const updateEndpoint = useMutation(api.endpoints.update);
  const deleteEndpoint = useMutation(api.endpoints.remove);

  const [name, setName] = useState("");
  const [mockStatus, setMockStatus] = useState("200");
  const [mockBody, setMockBody] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (endpoint) {
      setName(endpoint.name || "");
      setMockStatus(endpoint.mockResponse?.status?.toString() || "200");
      setMockBody(endpoint.mockResponse?.body || "");
    }
  }, [endpoint]);

  const webhookUrl = `${WEBHOOK_BASE_URL}/w/${slug}`;

  const copyUrl = async () => {
    const success = await copyToClipboard(webhookUrl);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSave = async () => {
    if (!endpoint) return;

    setIsSaving(true);
    setError(null);

    try {
      await updateEndpoint({
        id: endpoint._id,
        name: name || undefined,
        mockResponse: mockBody
          ? {
              status: parseStatusCode(mockStatus, 200),
              body: mockBody,
              headers: endpoint.mockResponse?.headers ?? {},
            }
          : undefined,
      });
      router.push(`/dashboard?endpoint=${slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!endpoint) return;

    setIsDeleting(true);
    try {
      await deleteEndpoint({ id: endpoint._id });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setIsDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  if (endpoint === undefined) {
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
          <div className="animate-pulse text-muted-foreground">Loading...</div>
        </main>
      </div>
    );
  }

  if (endpoint === null) {
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
          <p className="text-muted-foreground">Endpoint not found</p>
          <Button asChild className="mt-4">
            <Link href="/dashboard">Back to Dashboard</Link>
          </Button>
        </main>
      </div>
    );
  }

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
        <h1 className="text-2xl font-bold mb-6">Endpoint Settings</h1>

        <div className="space-y-6">
          {/* Webhook URL */}
          <div className="space-y-2">
            <Label>Webhook URL</Label>
            <div className="flex gap-2">
              <code className="flex-1 bg-muted px-3 py-2 rounded text-sm overflow-x-auto">
                {webhookUrl}
              </code>
              <Button variant="outline" size="icon" onClick={copyUrl}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Webhook"
            />
          </div>

          {/* Mock Response */}
          <div className="border rounded-lg p-4 space-y-4">
            <h2 className="font-semibold">Mock Response</h2>

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

          {/* Actions */}
          <div className="flex justify-between">
            <div className="flex gap-3">
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? "Saving..." : "Save Changes"}
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/dashboard?endpoint=${slug}`}>Cancel</Link>
              </Button>
            </div>

            <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="destructive">Delete</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete endpoint?</DialogTitle>
                  <DialogDescription>
                    This will permanently delete this endpoint and all its captured requests. This
                    action cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
                    {isDeleting ? "Deleting..." : "Delete"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </main>
    </div>
  );
}
