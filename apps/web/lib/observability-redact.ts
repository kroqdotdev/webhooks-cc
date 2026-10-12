/**
 * Redaction shared by the server and browser StatOSS clients. Email
 * addresses become `[email]` in everything sent: a query error, a console
 * breadcrumb or a page can quote one. No Node imports, so the browser bundle
 * can use it.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export function redactEmails(text: string): string {
  return text.replace(EMAIL, "[email]");
}

/** The event with every email address in it replaced. */
export function redactEvent<T>(event: T): T {
  try {
    return JSON.parse(redactEmails(JSON.stringify(event))) as T;
  } catch {
    return event;
  }
}
