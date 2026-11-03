"use client";

import { use } from "react";
import { OpsInbox } from "@/components/ops/inbox";

export default function OpsTicketPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = use(params);
  return <OpsInbox number={number} />;
}
