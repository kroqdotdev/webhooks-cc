/*
 * What a preview can be reported for: a short label for staff, and the words
 * the report form asks with. The keys are abuse_reports.kind (migration
 * 00091). Shared by the form (a client component) and the server. Child
 * sexual abuse is its own kind: it may be reported anonymously, and staff
 * see it first.
 */

export const REPORT_KINDS = {
  phishing: {
    label: "Phishing",
    ask: "It pretends to be another site to get passwords or payment details",
  },
  malware: {
    label: "Malware",
    ask: "It spreads malware or makes the browser download things",
  },
  csam: {
    label: "Child sexual abuse",
    ask: "It shows sexual abuse of a child",
  },
  illegal: {
    label: "Illegal content",
    ask: "It shows other illegal or hateful content",
  },
  copyright: {
    label: "Copyright or trademark",
    ask: "It copies my work or uses my trademark without permission",
  },
  privacy: {
    label: "Privacy",
    ask: "It shows someone's personal information without their consent",
  },
  spam: { label: "Spam", ask: "It is spam or a scam" },
  other: { label: "Something else", ask: "Something else" },
} as const;

export type ReportKind = keyof typeof REPORT_KINDS;

export function isReportKind(kind: string): kind is ReportKind {
  return Object.hasOwn(REPORT_KINDS, kind);
}
