import type { FAQItem } from "@/lib/schemas";

/**
 * Plan questions for webhooks.cc. The landing page's FAQ shows the first two
 * among its general questions; /pricing shows all of them. The facts follow
 * content/docs/plans-limits.mdx: change them together.
 */

export const IS_IT_FREE_FAQ: FAQItem = {
  question: "Is webhooks.cc free?",
  answer:
    "Yes. The free plan gives you 50 requests per day, 7-day retention, unlimited endpoints, and full CLI, SDK, and MCP access, with every Pro feature. Pro ($8/month) raises the limit to 100,000 requests per month with 31-day retention. Business ($29/month or $290/year) gives 250,000 requests a month, 90-day retention, 2,000 parsed attachment pages a month, up to 50 layouts per endpoint, a custom inbound domain and file drops to SFTP, FTP or S3. Teams are billed separately, from 2 seats: Teams at $12/seat/mo, or Team Business at $35/seat/mo ($350/seat/yr) with Business's limits per seat.",
};

export const TEAM_QUOTA_FAQ: FAQItem = {
  question: "Whose quota is used for shared team endpoints?",
  answer:
    "The team's. Once an endpoint is shared with a team that has an active Teams subscription, its incoming webhooks draw from the team's pooled quota (100,000 requests per seat per period on Teams, 250,000 on Team Business) instead of the owner's personal quota, and they are kept for 31 days, or 90 on Team Business, no matter which plan the owner is on. Endpoints that are not shared with an active team still count against the owner's own limit.",
};

export const PRICING_FAQ: FAQItem[] = [
  IS_IT_FREE_FAQ,
  {
    question: "What counts as a request?",
    answer:
      "Each HTTP request one of your endpoints captures, and each email it receives (an email addressed to two endpoints counts once for each). Forwarding a request to your destinations and SDK calls that send straight to your own handler do not count again.",
  },
  {
    question: "What happens when I run out?",
    answer:
      "New webhooks get 429 Too Many Requests with a Retry-After header that says when the quota resets, and new mail is refused as mailbox full, so senders retry or bounce instead of losing anything silently, and we email you that it is happening. Everything already captured stays.",
  },
  {
    question: "Can I go past my plan's quota?",
    answer:
      "On Pro, Business and subscribed teams, yes, in blocks of 25,000 requests: monthly blocks at $2 that renew with the plan, one-time blocks at $3 that never expire, or overage at $0.16 per 1,000 up to a monthly maximum you set. Business can add parsed attachment pages the same way.",
  },
  {
    question: "Can I change or cancel my plan?",
    answer:
      "Yes, under Account. Moving from Pro to Business monthly applies at once: you pay the difference for the rest of the period and get Business's extra requests and pages for that part of it. Other changes take effect at the renewal and can be undone until then. A canceled plan stays active until the end of the period you paid for, then the account moves to Free.",
  },
  {
    question: "Is there annual billing?",
    answer:
      "On Business ($290 a year) and Team Business ($350 a seat a year). Requests and parsed pages still reset every month.",
  },
  TEAM_QUOTA_FAQ,
  {
    question: "How do I pay, and where are my invoices?",
    answer:
      "Through Polar, our payment provider. Invoices, receipts and the card on file are in Polar's customer portal, opened from the plan page (or the team page for a team).",
  },
];
