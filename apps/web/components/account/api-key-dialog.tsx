"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Copy, Check, AlertTriangle } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { trackApiKeyCreated } from "@/lib/analytics";

interface ApiKeyDialogProps {
  accessToken: string | null;
  onCreated?: () => void;
}

export function ApiKeyDialog({ accessToken, onCreated }: ApiKeyDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("Give the key a name.");
      return;
    }

    if (!accessToken) {
      setError("Your session expired. Sign in again.");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: name.trim() }),
      });

      const data = (await response.json()) as { key?: string; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to create API key");
      }

      trackApiKeyCreated();
      setCreatedKey(data.key!);
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setIsCreating(false);
    }
  };

  const copyKey = async () => {
    if (!createdKey) return;
    const success = await copyToClipboard(createdKey);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setTimeout(() => {
      setName("");
      setCreatedKey(null);
      setError(null);
      setCopied(false);
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}>
      <DialogTrigger asChild>
        <Button>Create key</Button>
      </DialogTrigger>
      <DialogContent>
        {!createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle>Create an API key</DialogTitle>
              <DialogDescription>
                The key acts as you in the CLI, SDK, MCP server and API.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="keyName">Name</Label>
                <Input
                  id="keyName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Laptop CLI"
                />
                <p className="text-sm text-muted-foreground">
                  Name it after where you will use it, so you know which to delete later.
                </p>
              </div>

              {error && (
                <div
                  role="alert"
                  className="text-sm text-destructive bg-destructive/10 p-3 rounded-md"
                >
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={isCreating}>
                {isCreating ? "Creating..." : "Create key"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>Copy it now. It is not shown again.</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2 p-3 bg-muted rounded-lg border">
                <code className="flex-1 text-sm font-mono break-all">{createdKey}</code>
                <Button variant="ghost" size="icon" onClick={copyKey} aria-label="Copy key">
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>

              <div className="flex items-start gap-2 p-3 bg-amber-500/10 rounded-md border border-amber-500/40">
                <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  Store it somewhere safe, such as a password manager. If you lose it, delete it and
                  create a new one.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
