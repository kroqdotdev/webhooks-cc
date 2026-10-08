import { describe, expect, it } from "vitest";
import { extractFromEmail, htmlToText } from "../email/extract";

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
