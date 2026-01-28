"use client";

import { useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@convex/_generated/api";
import { Doc } from "@convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function EndpointSwitcher() {
  const endpoints = useQuery(api.endpoints.list);
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSlug = searchParams.get("endpoint");

  if (!endpoints || endpoints.length === 0) {
    return null;
  }

  const handleChange = (slug: string) => {
    router.push(`/dashboard?endpoint=${slug}`);
  };

  return (
    <Select value={currentSlug || endpoints[0]?.slug} onValueChange={handleChange}>
      <SelectTrigger className="w-[200px]">
        <SelectValue placeholder="Select endpoint" />
      </SelectTrigger>
      <SelectContent>
        {endpoints.map((endpoint: Doc<"endpoints">) => (
          <SelectItem key={endpoint._id} value={endpoint.slug}>
            {endpoint.name || endpoint.slug}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
