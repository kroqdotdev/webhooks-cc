import { describe, expect, it } from "vitest";
import { emailAnchors, extractFromEmail, htmlToText } from "../email/extract";

const confirmHtml = `<div style="font-family:Arial"><img src="https://tidewater.app/logo.png" alt="Tidewater">
<h1>Confirm your email</h1><p>Hi Ines,</p><p>Your confirmation code is</p>
<p style="font-size:32px">482913</p>
<p><a href="https://app.tidewater.app/confirm?token=Zk3q9v&amp;src=email">Confirm email</a></p>
<p><a href="https://tidewater.app/unsubscribe?u=8f3a">Unsubscribe</a> <a href="https://twitter.com/tidewater">Twitter</a></p>
<img src="https://track.tidewater.app/open/8f3a.gif" width="1" height="1"></div>`;

describe("extractFromEmail", () => {
  it("finds the code and the confirm link in a typical signup email", () => {
    const found = extractFromEmail({
      subject: "Confirm your email for Tidewater",
      text: null,
      html: confirmHtml,
    });
    expect(found.codes).toEqual(["482913"]);
    expect(found.links).toEqual([
      {
        url: "https://app.tidewater.app/confirm?token=Zk3q9v&src=email",
        label: "Confirm email",
        action: true,
      },
    ]);
  });

  it("reads codes from the subject and the text part, in either word order", () => {
    expect(
      extractFromEmail({ subject: "391 044 is your Acme login code", text: null, html: null }).codes
    ).toEqual(["391044"]);
    expect(
      extractFromEmail({
        subject: "Sign in to Northwind",
        text: "Use this code to sign in: K7Q2M9\nIt expires in 10 minutes.",
        html: null,
      }).codes
    ).toEqual(["K7Q2M9"]);
    expect(
      extractFromEmail({ subject: null, text: "Your verification code: 0815-2207", html: null })
        .codes
    ).toEqual(["08152207"]);
  });

  it("leaves order numbers, prices, years, phone numbers and dates alone", () => {
    const found = extractFromEmail({
      subject: "Your receipt from Tidewater #2026-1043",
      text: [
        "Thanks for your payment of $49.00 on 2026-10-07 at 22:40.",
        "Order 55120934, invoice INV-88213.",
        "Questions? Call +1 (312) 847-1928.",
        "Promo code valid until 2027.",
      ].join("\n"),
      html: null,
    });
    expect(found.codes).toEqual([]);
  });

  it("needs a code word on the same line, or on the line above a code that stands alone", () => {
    expect(
      extractFromEmail({
        subject: null,
        text: "Your code is below.\n\n482913\n\nThanks, the team",
        html: null,
      }).codes
    ).toEqual(["482913"]);
    expect(
      extractFromEmail({
        subject: null,
        text: "Use the code from the app.\nOrder 482913 ships tomorrow.",
        html: null,
      }).codes
    ).toEqual([]);
    expect(
      extractFromEmail({ subject: null, text: "Reference 482913 for your records.", html: null })
        .codes
    ).toEqual([]);
  });

  it("ranks action links first and drops footers, tracking and social links", () => {
    const found = extractFromEmail({
      subject: "Reset your password",
      text: [
        "Read our blog: https://tidewater.app/blog/launch.",
        "Reset it here: https://app.tidewater.app/reset?token=Qw81xk",
        "Manage preferences: https://tidewater.app/preferences",
        "Follow us: https://www.linkedin.com/company/tidewater",
        "Or write to mailto:help@tidewater.app",
      ].join("\n"),
      html: null,
    });
    expect(found.links.map((link) => [link.url, link.action])).toEqual([
      ["https://app.tidewater.app/reset?token=Qw81xk", true],
      ["https://tidewater.app/blog/launch", false],
    ]);
  });

  it("keeps verify and sign-in links on GitHub and Discord, and drops their footers", () => {
    const github = extractFromEmail({
      subject: "[GitHub] Please verify your device",
      text: [
        "Enter the code at https://github.com/login/device",
        "Or verify your address: https://github.com/users/octo-dev/emails/88213/confirm_verification/Zk3q9v?via_launch_code_email=true",
        "See what changed: https://github.com/acme/widgets/pull/42",
        "GitHub: https://github.com/github",
        "Support: https://support.github.com",
      ].join("\n"),
      html: null,
    });
    expect(github.links.map((link) => [link.url, link.action])).toEqual([
      ["https://github.com/login/device", true],
      [
        "https://github.com/users/octo-dev/emails/88213/confirm_verification/Zk3q9v?via_launch_code_email=true",
        true,
      ],
    ]);

    const discord = extractFromEmail({
      subject: "Verify Email Address for Discord",
      text: null,
      html: `<p><a href="https://click.discord.com/ls/click?upn=u001.Qw81xk">Verify Email</a></p>
<p><a href="https://discord.com/">Discord</a> <a href="https://twitter.com/discord">Twitter</a>
<a href="https://support.discord.com/hc">Help Center</a>
<a href="https://discord.com/settings/notifications">Notification preferences</a></p>`,
    });
    expect(discord.links.map((link) => [link.url, link.label, link.action])).toEqual([
      ["https://click.discord.com/ls/click?upn=u001.Qw81xk", "Verify Email", true],
    ]);
  });

  it("keeps action links on help and support hosts, and order tracking links", () => {
    const found = extractFromEmail({
      subject: "Your order has shipped",
      text: [
        "Track your order: https://shop.acme.test/orders/1043/track/",
        "Verify your support account: https://support.acme.test/verify?token=Qw81xk",
        "Click tracking: https://links.acme.test/track/click?id=9f2",
        "Need help? https://acme.test/help",
        "Help center: https://help.acme.test/articles/12",
        "Privacy: https://acme.test/legal/privacy",
        "https://mail.acme.test/wf/open?upn=8f3a",
        "https://mail.acme.test/track/open.php?u=8f3a",
        "https://mail.acme.test/o.gif",
        "https://www.linkedin.com/in/jane-doe",
        "https://www.youtube.com/@acme",
      ].join("\n"),
      html: null,
    });
    // A rescued link (here a support host's verify page) ranks after the
    // mail's own links: it only answers when nothing else does.
    expect(found.links.map((link) => [link.url, link.action])).toEqual([
      ["https://shop.acme.test/orders/1043/track/", false],
      ["https://links.acme.test/track/click?id=9f2", false],
      ["https://support.acme.test/verify?token=Qw81xk", true],
    ]);
  });

  it("does not let a query string rescue footer, social or help links", () => {
    // Campaign tags put an action word on every link of a mail.
    const utm = "?utm_campaign=password_reset";
    const found = extractFromEmail({
      subject: "Reset your password",
      text: null,
      html: [
        `<a href="https://acme.test/reset/k3y${utm}">Reset password</a>`,
        `<a href="https://help.acme.test/${utm}">Help</a>`,
        `<a href="https://twitter.com/acme${utm}">Twitter</a>`,
        `<a href="https://acme.test/privacy${utm}">Privacy</a>`,
        `<a href="https://support.acme.test/?ref=auth">Support</a>`,
        `<a href="https://acme.test/orders/123">View your order</a>`,
      ].join(""),
    });
    expect(found.links.map((link) => link.url)).toEqual([
      `https://acme.test/reset/k3y${utm}`,
      "https://acme.test/orders/123",
    ]);
  });

  it("keeps invites, short video links and ticket pages, and drops footer phrases", () => {
    const found = extractFromEmail({
      subject: null,
      text: null,
      html: [
        `<a href="https://discord.gg/abcdef">Join the server</a>`,
        `<a href="https://youtu.be/dQw4w9WgXcQ">Watch the demo</a>`,
        `<a href="https://acme.zendesk.com/agent/tickets/123/open">View ticket</a>`,
        `<a href="https://ct.sendgrid.net/ls/click?upn=1">Visit our Help Center</a>`,
        `<a href="https://ct.sendgrid.net/ls/click?upn=2">Privacy Notice</a>`,
      ].join(""),
    });
    expect(found.links.map((link) => link.url)).toEqual([
      "https://discord.gg/abcdef",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://acme.zendesk.com/agent/tickets/123/open",
    ]);
  });

  it("keeps app pages that name contact or faq, and drops help and legal pages", () => {
    const found = extractFromEmail({
      subject: null,
      text: [
        "View contact: https://app.hubspot.com/contacts/123/contact/456",
        "View submission: https://app.acme.test/forms/contact/submissions/77",
        "Edit FAQ: https://admin.acme.test/faq/42/edit",
        "https://acme.test/privacy",
        "https://acme.test/legal/terms",
        "https://support.acme.test/hc/en-us/articles/42",
        "https://acme.test/help/article/42",
      ].join("\n"),
      html: null,
    });
    expect(found.links.map((link) => link.url)).toEqual([
      "https://app.hubspot.com/contacts/123/contact/456",
      "https://app.acme.test/forms/contact/submissions/77",
      "https://admin.acme.test/faq/42/edit",
    ]);
  });

  it("rescues a help or support link only by its host and path, never its label or query", () => {
    const kept = (url: string, label: string) =>
      extractFromEmail({ subject: null, text: null, html: `<a href="${url}">${label}</a>` }).links
        .length > 0;
    expect(kept("https://support.acme.test/verify?t=1", "Open")).toBe(true);
    expect(kept("https://help.acme.test/password/reset/k3y", "Open")).toBe(true);
    // An article about an action, or a campaign tag, is no action.
    expect(kept("https://acme.test/help/articles/42", "How to reset 2FA")).toBe(false);
    expect(kept("https://support.google.test/accounts?p=signin_alert", "Learn more")).toBe(false);
    expect(kept("https://acme.test/privacy?utm_campaign=password_reset", "Privacy")).toBe(false);
  });

  it("never lets a footer, help article or pixel win over the mail's own link", () => {
    const kept = (url: string, label = "Link") =>
      extractFromEmail({ subject: null, text: null, html: `<a href="${url}">${label}</a>` }).links
        .length > 0;
    for (const url of [
      "https://auth0.com/privacy",
      "https://login.acme.test/terms",
      "https://acme.test/legal/acceptable-use",
      "https://acme.test/support/login",
      "https://help.acme.test/articles/reset-password",
      "https://support.acme.test/hc/en-us/articles/password-security",
      "https://acme.test/manage_notifications_settings",
      "https://auth.acme.test/open/abc.gif",
    ]) {
      expect(kept(url), url).toBe(false);
    }
    const receipt = extractFromEmail({
      subject: "Your receipt",
      text: null,
      html: `<a href="https://pay.acme.test/receipts/77">View receipt</a> <a href="https://acme.test/legal/acceptable-use">Acceptable use</a>`,
    });
    expect(receipt.links.map((link) => link.url)).toEqual(["https://pay.acme.test/receipts/77"]);
  });

  it("drops unsubscribe links even when they carry a token", () => {
    const found = extractFromEmail({
      subject: null,
      text: null,
      html: `<a href="https://acme.test/email/unsubscribe?token=Zk3q9v">Unsubscribe</a>
<a href="https://acme.test/account?auth=Qw81xk">Manage email preferences</a>
<a href="https://acme.test/confirm?token=Zk3q9v">Confirm</a>`,
    });
    expect(found.links.map((link) => link.url)).toEqual(["https://acme.test/confirm?token=Zk3q9v"]);
  });

  it("does not list a link twice when it is in both parts", () => {
    const found = extractFromEmail({
      subject: null,
      text: "Confirm: https://app.tidewater.app/confirm?token=Zk3q9v",
      html: '<a href="https://app.tidewater.app/confirm?token=Zk3q9v">Confirm</a>',
    });
    expect(found.links).toHaveLength(1);
    expect(found.links[0].label).toBe("Confirm");
  });

  it("returns nothing for an empty email", () => {
    expect(extractFromEmail({ subject: null, text: null, html: null })).toEqual({
      codes: [],
      links: [],
    });
  });
});

describe("htmlToText", () => {
  it("keeps block structure as lines and drops markup, styles and scripts", () => {
    expect(
      htmlToText(
        "<style>p{color:red}</style><p>Hi&nbsp;Ines,</p><p>Code <b>482913</b></p><script>x()</script>"
      )
    ).toBe("Hi Ines,\nCode 482913");
  });

  it("decodes each entity once", () => {
    expect(htmlToText("<p>&amp;lt;b&amp;gt; is &lt;b&gt;, &QUOT;Tom &amp; Jerry&quot;</p>")).toBe(
      '&lt;b&gt; is <b>, "Tom & Jerry"'
    );
  });
});

describe("extraction time on hostile input", () => {
  // Email bodies come from anyone and are scanned on the server when forwarding;
  // each of these took between 2 seconds and 2 minutes with backtracking patterns.
  const size = 256 * 1024;
  const hostile: Record<string, { subject: null; text: string | null; html: string | null }> = {
    "unclosed angle brackets": { subject: null, text: null, html: "<".repeat(size) },
    "anchors without a closing bracket": {
      subject: null,
      text: null,
      html: "<a ".repeat(size / 3),
    },
    "anchors without a closing tag": {
      subject: null,
      text: null,
      html: '<a href="https://x.io/confirm">'.repeat(size / 32),
    },
    "unquoted href of punctuation": {
      subject: null,
      text: null,
      html: "<a href=" + "!".repeat(size),
    },
    "unclosed script elements": { subject: null, text: null, html: "<script>".repeat(size / 8) },
    "url followed by punctuation": {
      subject: null,
      text: "see https://x.io/" + "!".repeat(size) + "x",
      html: null,
    },
    "punctuation line": { subject: null, text: "code\n" + "!".repeat(size) + "a", html: null },
    "code word and capitals": { subject: null, text: "code " + "A".repeat(size), html: null },
    "a distinct code on every line": {
      subject: null,
      text: Array.from({ length: size / 12 }, (_, i) => `code ${100000 + i}`).join("\n"),
      html: null,
    },
  };

  for (const [name, email] of Object.entries(hostile)) {
    it(`finishes quickly: ${name}`, () => {
      const started = performance.now();
      extractFromEmail(email);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  }
});

describe("code limit", () => {
  it("keeps the first 20 codes, in order", () => {
    const text = Array.from({ length: 30 }, (_, i) => `code ${100000 + i}`).join("\n");
    const { codes } = extractFromEmail({ subject: "Your code is 999999", text, html: null });
    expect(codes).toHaveLength(20);
    expect(codes.slice(0, 3)).toEqual(["999999", "100000", "100001"]);
    expect(codes[19]).toBe("100018");
  });
});

describe("tag handling edge cases", () => {
  it("keeps the text of unclosed elements and a stray angle bracket", () => {
    expect(htmlToText("a < b")).toBe("a < b");
    expect(htmlToText("<p>Hi</p><script>x")).toBe("Hi\nx");
    expect(htmlToText("<style>p{}</style>Your code is 123456")).toBe("Your code is 123456");
    expect(htmlToText("x <> y")).toBe("x <> y");
  });

  it("reads anchors with any quoting and skips ones without href", () => {
    const html =
      '<a name="top">Top</a><a class=btn href=https://x.io/verify?t=1>Verify</a>' +
      "<A HREF='https://x.io/reset'>Reset</A><abbr>no</abbr>";
    const { links } = extractFromEmail({ subject: null, text: null, html });
    expect(links.map((link) => [link.url, link.label])).toEqual([
      ["https://x.io/verify?t=1", "Verify"],
      ["https://x.io/reset", "Reset"],
    ]);
  });

  it("keeps positions right after characters whose lowercase is longer", () => {
    // "İ" lowercases to two code units; the scans must still slice the right text.
    const html =
      "<p>İİİ</p><style>x</style><A HREF='https://x.io/verify'>Verify now</A> code 482913";
    const found = extractFromEmail({ subject: null, text: null, html });
    expect(found.links[0]).toEqual({
      url: "https://x.io/verify",
      label: "Verify now",
      action: true,
    });
    expect(found.codes).toEqual(["482913"]);
    expect(htmlToText(html)).toBe("İİİ\nVerify now code 482913");
  });

  it("trims trailing punctuation from links in text", () => {
    const { links } = extractFromEmail({
      subject: null,
      text: "Confirm here: https://x.io/confirm?t=9!?.",
      html: null,
    });
    expect(links[0]?.url).toBe("https://x.io/confirm?t=9");
  });
});

describe("emailAnchors", () => {
  it("keeps every http link with its text, footers included", () => {
    expect(emailAnchors(confirmHtml)).toEqual([
      { url: "https://app.tidewater.app/confirm?token=Zk3q9v&src=email", text: "Confirm email" },
      { url: "https://tidewater.app/unsubscribe?u=8f3a", text: "Unsubscribe" },
      { url: "https://twitter.com/tidewater", text: "Twitter" },
    ]);
  });

  it("drops other schemes and links inside style or script", () => {
    const html = `<a href="mailto:a@x.io">mail</a><style>a{}</style><script><a href="https://x.io/s">s</a></script><a href='http://x.io/p'><b>Plain</b></a>`;
    expect(emailAnchors(html)).toEqual([{ url: "http://x.io/p", text: "Plain" }]);
  });

  it("keeps every link and stays fast on hostile input", () => {
    const many = '<a href="https://x.io/a">a</a>'.repeat(2_000);
    expect(emailAnchors(many)).toHaveLength(2_000);
    const started = Date.now();
    emailAnchors("<a href=x>".repeat(20_000) + "<a".repeat(50_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
