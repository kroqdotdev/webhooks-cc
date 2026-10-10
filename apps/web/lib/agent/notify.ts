import { publicEnv } from "@/lib/env";
import { sendEmail } from "@/lib/email/mailer";

/**
 * Tells the account owner an agent was connected (D6), so a connection made
 * by a phished claim does not go unnoticed. Never throws: the claim has
 * already happened.
 */
export async function notifyAgentConnected(input: {
  email: string;
  clientName: string | null;
  adopted: string[];
}): Promise<void> {
  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  const lines = [
    "An AI agent was connected to your webhooks.cc account.",
    "",
    `Agent: ${input.clientName ?? "unnamed"} (the name the agent gave itself)`,
    `Connected: ${new Date().toUTCString()}`,
  ];
  if (input.adopted.length > 0) {
    lines.push(`Endpoints moved into your account: ${input.adopted.join(", ")}`);
  }
  lines.push(
    "",
    "It can now use the webhooks.cc API on your behalf. If you did not do this, disconnect it under Connected agents:",
    `${appUrl}/account#connected-agents`
  );
  try {
    await sendEmail({
      to: input.email,
      subject: "An agent was connected to your webhooks.cc account",
      text: lines.join("\n"),
    });
  } catch (error) {
    console.error("[agent] connection notice failed:", (error as Error).message);
  }
}
