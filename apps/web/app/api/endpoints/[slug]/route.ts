import { authenticateRequest, convexCliRequest } from "@/lib/api-auth";

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  return convexCliRequest("/cli/endpoints", {
    method: "DELETE",
    body: { userId: auth.userId, slug },
  });
}
