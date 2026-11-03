"use client";

import { use } from "react";
import { ViewAs } from "@/components/ops/view-as";

export default function OpsViewPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  return <ViewAs sessionId={sessionId} />;
}
