"use client";

import { use } from "react";
import { AccountInspector } from "@/components/ops/accounts";

export default function OpsAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AccountInspector id={id} />;
}
