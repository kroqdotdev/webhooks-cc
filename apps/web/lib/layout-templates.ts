import type { Layout } from "@webhooks-cc/sdk/email";

/**
 * Ready-made layouts for common senders, shown on mailhooks.cc's sender
 * pages (/parse/[id]) and added to an endpoint from there. Each has a sample
 * email and what the layout reads from it; a unit test runs every layout on
 * its sample and checks the result, so the pages never show output the
 * layout does not give.
 *
 * The samples are illustrative: real emails differ by store, settings and
 * language, so the pages say to try the layout on one of your own emails in
 * the preview and adjust a pattern where a field comes back empty.
 */

export interface TemplateSample {
  subject: string;
  from: { name: string; address: string };
  /** The text as a reader sees it (and the text part, for text layouts). */
  text: string;
  /** The HTML part, for layouts that read the HTML. */
  html?: string;
  /** An attachment the sample carries, by name (parsing is shown, not run). */
  attachment?: string;
}

export interface LayoutTemplate {
  /** The page's path segment and the layout's id. */
  id: string;
  /** Who sends the email. */
  sender: string;
  /** What kind of email, in a phrase: "order notifications". */
  kind: string;
  /** Page title. */
  title: string;
  /** Meta description and the card's text. */
  description: string;
  /** The page's opening paragraph. */
  intro: string;
  sample: TemplateSample;
  layout: Layout;
  /** What the layout reads from the sample (asserted by the unit test). */
  result: {
    fields: Record<string, string | null>;
    lineItems: Record<string, string | null>[];
  };
  /** What a reader may want to change. */
  tips: string[];
}

const MONEY = "([0-9][0-9.,]*)";

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: "shopify-orders",
    sender: "Shopify",
    kind: "order notifications",
    title: "Parse Shopify order emails",
    description:
      "Turn Shopify's new-order notifications into JSON: order number, customer, totals and one row per product, delivered to your webhook or Google Sheets.",
    intro:
      "Shopify emails the store's staff for every new order. Forward those notifications to a mailhooks.cc address and this layout reads the order number, the customer and the totals, and turns the order summary into line items.",
    sample: {
      subject: "[Acme Store] Order #1042 placed by Jane Doe",
      from: { name: "Acme Store", address: "orders@acme-store.example" },
      text: [
        "Jane Doe placed order #1042 on Oct 29 at 10:14 am.",
        "",
        "Order summary",
        "Linen shirt × 2  $78.00",
        "Canvas tote × 1  $24.00",
        "",
        "Subtotal  $102.00",
        "Shipping  $6.00",
        "Total  $108.00 USD",
        "",
        "Shipping address",
        "Jane Doe",
        "1 Main Street",
        "Springfield",
      ].join("\n"),
    },
    layout: {
      id: "shopify-orders",
      name: "Shopify orders",
      match: {
        conditions: [{ field: "email", name: "subject", op: "contains", value: "placed by" }],
      },
      fields: [
        { name: "order", from: "subject", pattern: "Order #(\\d+)" },
        { name: "customer", from: "subject", pattern: "placed by (.+)$" },
        { name: "subtotal", from: "text", pattern: `Subtotal\\s+[$€£]?${MONEY}` },
        { name: "shipping", from: "text", pattern: `Shipping\\s+[$€£]?${MONEY}` },
        { name: "total", from: "text", pattern: `(?m)^Total\\s+[$€£]?${MONEY}` },
        { name: "currency", from: "text", pattern: "(?m)^Total\\s+\\S+\\s+([A-Z]{3})" },
      ],
      lineItems: {
        from: "text",
        start: "Order summary",
        end: "Subtotal",
        pattern: `(?m)^(?P<product>.+?) × (?P<quantity>\\d+)\\s+[$€£]?(?P<price>${MONEY.slice(1, -1)})\\s*$`,
      },
    },
    result: {
      fields: {
        order: "1042",
        customer: "Jane Doe",
        subtotal: "102.00",
        shipping: "6.00",
        total: "108.00",
        currency: "USD",
      },
      lineItems: [
        { product: "Linen shirt", quantity: "2", price: "78.00" },
        { product: "Canvas tote", quantity: "1", price: "24.00" },
      ],
    },
    tips: [
      "A store set to another language words the subject differently: change the match condition and the customer pattern to your subject.",
      "Prices in dollars, euros or pounds match, with the sign in front or none; the currency field reads the code after the total.",
    ],
  },
  {
    id: "woocommerce-orders",
    sender: "WooCommerce",
    kind: "new-order emails",
    title: "Parse WooCommerce order emails",
    description:
      "Read WooCommerce's admin new-order emails into JSON: order number, customer, payment method, total and the ordered products as rows.",
    intro:
      "WooCommerce sends the shop admin a new-order email with a table of products. This layout reads the order details and turns each row of that table into a line item.",
    sample: {
      subject: "[Acme Store]: New order #2187",
      from: { name: "Acme Store", address: "wordpress@acme-store.example" },
      text: [
        "You've received the following order from Jane Doe:",
        "[Order #2187] (October 29, 2026)",
        "Product Quantity Price",
        "Linen shirt 2 $78.00",
        "Canvas tote 1 $24.00",
        "Subtotal: $102.00",
        "Shipping: $6.00 via Flat rate",
        "Payment method: Credit card",
        "Total: $108.00",
      ].join("\n"),
      html: [
        "<p>You've received the following order from Jane Doe:</p>",
        "<h2>[Order #2187] (October 29, 2026)</h2>",
        "<table><thead><tr><th>Product</th><th>Quantity</th><th>Price</th></tr></thead>",
        "<tbody><tr><td>Linen shirt</td><td>2</td><td>$78.00</td></tr>",
        "<tr><td>Canvas tote</td><td>1</td><td>$24.00</td></tr></tbody>",
        "<tfoot><tr><th>Subtotal:</th><td>$102.00</td></tr>",
        "<tr><th>Shipping:</th><td>$6.00 via Flat rate</td></tr>",
        "<tr><th>Payment method:</th><td>Credit card</td></tr>",
        "<tr><th>Total:</th><td>$108.00</td></tr></tfoot></table>",
      ].join(""),
    },
    layout: {
      id: "woocommerce-orders",
      name: "WooCommerce orders",
      match: {
        conditions: [{ field: "email", name: "subject", op: "contains", value: "New order #" }],
      },
      fields: [
        { name: "order", from: "subject", pattern: "#(\\d+)" },
        { name: "customer", from: "html", pattern: "order from ([^\\r\\n:]+):" },
        { name: "payment", from: "html", pattern: "Payment method:[ \\t]*([^\\r\\n]+)" },
        { name: "total", from: "html", pattern: `Total:\\s*\\$?${MONEY}` },
      ],
      lineItems: {
        from: "html",
        start: "Product Quantity Price",
        end: "Subtotal:",
        pattern: "(?m)^(?P<product>.+?) (?P<quantity>\\d+) \\$?(?P<price>[0-9][0-9.,]*)$",
      },
    },
    result: {
      fields: { order: "2187", customer: "Jane Doe", payment: "Credit card", total: "108.00" },
      lineItems: [
        { product: "Linen shirt", quantity: "2", price: "78.00" },
        { product: "Canvas tote", quantity: "1", price: "24.00" },
      ],
    },
    tips: [
      "It reads the HTML email's order table, a row per product; if your theme adds columns (an SKU, a discount), add them to the line-item pattern in the preview.",
    ],
  },
  {
    id: "etsy-sales",
    sender: "Etsy",
    kind: "sale notifications",
    title: "Parse Etsy sale emails",
    description:
      "Turn Etsy's sale notifications into JSON: order number, buyer, items, quantities, total and ship-by date, ready for your webhook or spreadsheet.",
    intro:
      "Etsy tells you about every sale by email. This layout reads the order number, the buyer, the ship-by date and the total, and lists each item with its quantity and price.",
    sample: {
      subject: "You made a sale on Etsy! Order #3123456789",
      from: { name: "Etsy", address: "transaction@etsy.example" },
      text: [
        "Congratulations! You made a sale.",
        "",
        "Order number: 3123456789",
        "Buyer: Jane Doe",
        "",
        "Item: Hand-thrown mug",
        "Quantity: 2",
        "Price: $36.00",
        "",
        "Item: Linen napkins",
        "Quantity: 1",
        "Price: $9.00",
        "",
        "Order total: $45.00",
        "Ship by: Nov 3, 2026",
      ].join("\n"),
    },
    layout: {
      id: "etsy-sales",
      name: "Etsy sales",
      match: {
        conditions: [{ field: "email", name: "subject", op: "contains", value: "sale on Etsy" }],
      },
      fields: [
        { name: "order", from: "text", pattern: "Order number:\\s*(\\d+)" },
        { name: "buyer", from: "text", pattern: "Buyer:[ \\t]*([^\\r\\n]+)" },
        { name: "total", from: "text", pattern: `Order total:\\s*\\$?${MONEY}` },
        { name: "ship_by", from: "text", pattern: "Ship by:[ \\t]*([^\\r\\n]+)" },
      ],
      lineItems: {
        from: "text",
        pattern:
          "Item: (?P<item>[^\\r\\n]+)\\r?\\nQuantity: (?P<quantity>\\d+)\\r?\\nPrice: \\$?(?P<price>[0-9][0-9.,]*)",
      },
    },
    result: {
      fields: { order: "3123456789", buyer: "Jane Doe", total: "45.00", ship_by: "Nov 3, 2026" },
      lineItems: [
        { item: "Hand-thrown mug", quantity: "2", price: "36.00" },
        { item: "Linen napkins", quantity: "1", price: "9.00" },
      ],
    },
    tips: [
      "Personalization and variations show as extra lines; add a field or a column to the pattern for them.",
    ],
  },
  {
    id: "amazon-seller-orders",
    sender: "Amazon Seller Central",
    kind: "sold, ship now emails",
    title: "Parse Amazon seller order emails",
    description:
      "Read Amazon Seller Central's sold, ship now emails into JSON: order ID, item, SKU, quantity, price and ship-by date.",
    intro:
      "Amazon emails sellers when an item sells and needs shipping. This layout reads the order ID, the SKU, the quantity, the price and the date to ship by.",
    sample: {
      subject: "Sold, ship now: 1 x Linen shirt",
      from: { name: "Amazon Seller Central", address: "seller-notification@amazon.example" },
      text: [
        "Congratulations, you've sold an item!",
        "",
        "Order ID: 113-1234567-1234567",
        "Item: Linen shirt",
        "Condition: New",
        "SKU: LS-01",
        "Quantity: 1",
        "Order date: Oct 29, 2026",
        "Price: $39.00",
        "Shipping: $4.99",
        "Ship by: Nov 1, 2026",
      ].join("\n"),
    },
    layout: {
      id: "amazon-seller-orders",
      name: "Amazon seller orders",
      match: {
        conditions: [
          { field: "email", name: "subject", op: "starts_with", value: "Sold, ship now" },
        ],
      },
      fields: [
        { name: "order_id", from: "text", pattern: "Order ID:\\s*([0-9-]+)" },
        { name: "item", from: "text", pattern: "Item:[ \\t]*([^\\r\\n]+)" },
        { name: "sku", from: "text", pattern: "SKU:\\s*(\\S+)" },
        { name: "quantity", from: "text", pattern: "Quantity:\\s*(\\d+)" },
        { name: "price", from: "text", pattern: `Price:\\s*\\$?${MONEY}` },
        { name: "ship_by", from: "text", pattern: "Ship by:[ \\t]*([^\\r\\n]+)" },
      ],
    },
    result: {
      fields: {
        order_id: "113-1234567-1234567",
        item: "Linen shirt",
        sku: "LS-01",
        quantity: "1",
        price: "39.00",
        ship_by: "Nov 1, 2026",
      },
      lineItems: [],
    },
    tips: [
      "Marketplaces in other languages use their own labels: copy the label in front of each value into its pattern.",
    ],
  },
  {
    id: "ebay-sales",
    sender: "eBay",
    kind: "item sold emails",
    title: "Parse eBay item sold emails",
    description:
      "Turn eBay's item sold emails into JSON: item, sale price, buyer and order number, delivered to a webhook or a Google Sheet.",
    intro:
      "eBay emails you when an item sells. This layout reads the item, the price it sold for, the buyer's user ID and the order number.",
    sample: {
      subject: "You sold: Vintage film camera",
      from: { name: "eBay", address: "ebay@ebay.example" },
      text: [
        "Your item sold!",
        "",
        "Item: Vintage film camera",
        "Sold for: $120.00",
        "Buyer: jdoe_photos",
        "Order number: 12-34567-89012",
        "",
        "Ship it by Nov 3 to keep your seller performance up.",
      ].join("\n"),
    },
    layout: {
      id: "ebay-sales",
      name: "eBay sales",
      match: {
        conditions: [{ field: "email", name: "subject", op: "starts_with", value: "You sold" }],
      },
      fields: [
        { name: "item", from: "subject", pattern: "You sold:[ \\t]*([^\\r\\n]+)" },
        { name: "price", from: "text", pattern: `Sold for:\\s*\\$?${MONEY}` },
        { name: "buyer", from: "text", pattern: "Buyer:\\s*(\\S+)" },
        { name: "order", from: "text", pattern: "Order number:\\s*([0-9-]+)" },
      ],
    },
    result: {
      fields: {
        item: "Vintage film camera",
        price: "120.00",
        buyer: "jdoe_photos",
        order: "12-34567-89012",
      },
      lineItems: [],
    },
    tips: [
      "Several items in one purchase come as one email per item; each becomes its own JSON delivery.",
    ],
  },
  {
    id: "stripe-receipts",
    sender: "Stripe",
    kind: "payment receipts",
    title: "Parse Stripe receipt emails",
    description:
      "Read Stripe receipt emails into JSON: receipt number, amount paid, date, payment method and each line of the summary.",
    intro:
      "Stripe emails a receipt for each successful payment, to the customer and, if you ask for a copy, to you. This layout reads the receipt number, the amount, the date and the card, and lists the summary's lines.",
    sample: {
      subject: "Your receipt from Acme #1234-5678",
      from: { name: "Acme", address: "receipts@stripe.example" },
      text: [
        "Receipt from Acme",
        "Receipt #1234-5678",
        "",
        "Amount paid",
        "$49.00",
        "Date paid",
        "Oct 29, 2026",
        "Payment method",
        "Visa - 4242",
        "",
        "Summary",
        "Pro plan × 1  $40.00",
        "Extra seats × 3  $9.00",
        "Amount paid  $49.00",
      ].join("\n"),
    },
    layout: {
      id: "stripe-receipts",
      name: "Stripe receipts",
      match: {
        conditions: [{ field: "email", name: "subject", op: "contains", value: "receipt from" }],
      },
      fields: [
        { name: "receipt", from: "text", pattern: "Receipt #([0-9-]+)" },
        { name: "amount", from: "text", pattern: `Amount paid\\s+\\$?${MONEY}` },
        { name: "date", from: "text", pattern: "Date paid\\s+([^\\r\\n]+)" },
        { name: "card", from: "text", pattern: "Payment method\\s+([^\\r\\n]+)" },
      ],
      lineItems: {
        from: "text",
        start: "Summary",
        end: "Amount paid",
        pattern: "(?m)^(?P<item>.+?) × (?P<quantity>\\d+)\\s+\\$?(?P<amount>[0-9][0-9.,]*)\\s*$",
      },
    },
    result: {
      fields: { receipt: "1234-5678", amount: "49.00", date: "Oct 29, 2026", card: "Visa - 4242" },
      lineItems: [
        { item: "Pro plan", quantity: "1", amount: "40.00" },
        { item: "Extra seats", quantity: "3", amount: "9.00" },
      ],
    },
    tips: [
      "Receipts in a customer's language word the labels differently; match on the receipt number's pattern instead of the subject if you sell in several languages.",
    ],
  },
  {
    id: "paypal-payments",
    sender: "PayPal",
    kind: "payment received emails",
    title: "Parse PayPal payment received emails",
    description:
      "Turn PayPal's payment received emails into JSON: payer, amount, currency, transaction ID and the payer's note.",
    intro:
      "PayPal emails you when someone sends you money. This layout reads who paid, how much and in which currency, the transaction ID and any note the payer added.",
    sample: {
      subject: "You've got money",
      from: { name: "PayPal", address: "service@paypal.example" },
      text: [
        "Jane Doe sent you $25.00 USD",
        "",
        "Transaction ID: 9AB12345CD678901E",
        "Transaction date: Oct 29, 2026",
        "Note: For the October invoice",
      ].join("\n"),
    },
    layout: {
      id: "paypal-payments",
      name: "PayPal payments",
      match: {
        conditions: [{ field: "email", name: "text", op: "contains", value: "sent you" }],
      },
      fields: [
        { name: "payer", from: "text", pattern: "(?m)^(.+?) sent you" },
        { name: "amount", from: "text", pattern: `sent you \\$?${MONEY}` },
        { name: "currency", from: "text", pattern: "sent you \\S+ ([A-Z]{3})" },
        { name: "transaction", from: "text", pattern: "Transaction ID:\\s*([A-Z0-9]+)" },
        { name: "note", from: "text", pattern: "Note:[ \\t]*([^\\r\\n]+)" },
      ],
    },
    result: {
      fields: {
        payer: "Jane Doe",
        amount: "25.00",
        currency: "USD",
        transaction: "9AB12345CD678901E",
        note: "For the October invoice",
      },
      lineItems: [],
    },
    tips: ["A payment without a note leaves the note field null; the delivery still goes out."],
  },
  {
    id: "booking-com-reservations",
    sender: "Booking.com",
    kind: "new booking emails",
    title: "Parse Booking.com reservation emails",
    description:
      "Read Booking.com new-booking emails into JSON: booking number, guest, check-in and check-out dates, room, guests and price.",
    intro:
      "Booking.com emails properties about each new reservation. This layout reads the booking number, the guest's name, the dates, the room, the number of guests and the price, so a channel manager, a spreadsheet or a chat gets them at once.",
    sample: {
      subject: "New booking! (1234567890, Saturday, 1 November 2026)",
      from: { name: "Booking.com", address: "noreply@booking.example" },
      text: [
        "You have a new booking",
        "",
        "Booking number: 1234567890",
        "Guest name: Jane Doe",
        "Check-in: Sat 1 Nov 2026",
        "Check-out: Tue 4 Nov 2026",
        "Room: Double Room",
        "Number of guests: 2",
        "Total price: € 360",
      ].join("\n"),
    },
    layout: {
      id: "booking-com-reservations",
      name: "Booking.com reservations",
      match: {
        conditions: [{ field: "email", name: "subject", op: "starts_with", value: "New booking" }],
      },
      fields: [
        { name: "booking", from: "text", pattern: "Booking number:\\s*(\\d+)" },
        { name: "guest", from: "text", pattern: "Guest name:[ \\t]*([^\\r\\n]+)" },
        { name: "check_in", from: "text", pattern: "Check-in:[ \\t]*([^\\r\\n]+)" },
        { name: "check_out", from: "text", pattern: "Check-out:[ \\t]*([^\\r\\n]+)" },
        { name: "room", from: "text", pattern: "Room:[ \\t]*([^\\r\\n]+)" },
        { name: "guests", from: "text", pattern: "Number of guests:\\s*(\\d+)" },
        { name: "price", from: "text", pattern: "Total price:[ \\t]*([^\\r\\n]+)" },
      ],
    },
    result: {
      fields: {
        booking: "1234567890",
        guest: "Jane Doe",
        check_in: "Sat 1 Nov 2026",
        check_out: "Tue 4 Nov 2026",
        room: "Double Room",
        guests: "2",
        price: "€ 360",
      },
      lineItems: [],
    },
    tips: [
      "Cancellations and changes come with their own subjects: add a second layout matching them, so each kind gets its own fields.",
    ],
  },
  {
    id: "airbnb-reservations",
    sender: "Airbnb",
    kind: "reservation confirmations",
    title: "Parse Airbnb reservation emails",
    description:
      "Turn Airbnb's reservation confirmed emails into JSON: guest, check-in, checkout, guests, confirmation code and payout.",
    intro:
      "Airbnb emails hosts when a reservation is confirmed. This layout reads the guest, the check-in and checkout dates, the number of guests, the confirmation code and what you earn.",
    sample: {
      subject: "Reservation confirmed - Jane Doe arrives Nov 1",
      from: { name: "Airbnb", address: "automated@airbnb.example" },
      text: [
        "New booking confirmed! Jane arrives Nov 1.",
        "",
        "Check-in",
        "Sat, Nov 1",
        "3:00 PM",
        "Checkout",
        "Tue, Nov 4",
        "11:00 AM",
        "",
        "Guests",
        "2 adults",
        "",
        "Confirmation code",
        "HMABCD1234",
        "",
        "You earn",
        "$412.00",
      ].join("\n"),
    },
    layout: {
      id: "airbnb-reservations",
      name: "Airbnb reservations",
      match: {
        conditions: [
          { field: "email", name: "subject", op: "starts_with", value: "Reservation confirmed" },
        ],
      },
      fields: [
        { name: "guest", from: "subject", pattern: "confirmed - (.+?) arrives" },
        { name: "check_in", from: "text", pattern: "Check-in\\r?\\n([^\\r\\n]+)" },
        { name: "checkout", from: "text", pattern: "Checkout\\r?\\n([^\\r\\n]+)" },
        { name: "guests", from: "text", pattern: "Guests\\r?\\n([^\\r\\n]+)" },
        { name: "code", from: "text", pattern: "Confirmation code\\r?\\n(\\S+)" },
        { name: "payout", from: "text", pattern: `You earn\\r?\\n\\$?${MONEY}` },
      ],
    },
    result: {
      fields: {
        guest: "Jane Doe",
        check_in: "Sat, Nov 1",
        checkout: "Tue, Nov 4",
        guests: "2 adults",
        code: "HMABCD1234",
        payout: "412.00",
      },
      lineItems: [],
    },
    tips: [
      "Airbnb's HTML layout changes now and then; when a field comes back empty, open the email's text in the preview and move the pattern to the new label.",
    ],
  },
  {
    id: "calendly-bookings",
    sender: "Calendly",
    kind: "new event notifications",
    title: "Parse Calendly booking emails",
    description:
      "Read Calendly's new event emails into JSON: event type, invitee, invitee email, date and time, and location.",
    intro:
      "Calendly emails you when someone books a meeting. This layout reads the event type, who booked, their email address, when and where, ready for a CRM, a sheet or a chat channel.",
    sample: {
      subject: "New Event: Jane Doe - 10:00am Thu, Nov 6, 2026 - 30 Minute Meeting",
      from: { name: "Calendly", address: "notifications@calendly.example" },
      text: [
        "Hi Acme,",
        "",
        "A new event has been scheduled.",
        "",
        "Event Type:",
        "30 Minute Meeting",
        "",
        "Invitee:",
        "Jane Doe",
        "",
        "Invitee Email:",
        "jane@example.com",
        "",
        "Event Date/Time:",
        "10:00am - Thursday, November 6, 2026 (Central European Time)",
        "",
        "Location:",
        "Google Meet",
      ].join("\n"),
    },
    layout: {
      id: "calendly-bookings",
      name: "Calendly bookings",
      match: {
        conditions: [{ field: "email", name: "subject", op: "starts_with", value: "New Event" }],
      },
      fields: [
        { name: "event_type", from: "text", pattern: "Event Type:\\r?\\n([^\\r\\n]+)" },
        { name: "invitee", from: "text", pattern: "Invitee:\\r?\\n([^\\r\\n]+)" },
        { name: "email", from: "text", pattern: "Invitee Email:\\r?\\n(\\S+)" },
        { name: "when", from: "text", pattern: "Event Date/Time:\\r?\\n([^\\r\\n]+)" },
        { name: "location", from: "text", pattern: "Location:\\r?\\n([^\\r\\n]+)" },
      ],
    },
    result: {
      fields: {
        event_type: "30 Minute Meeting",
        invitee: "Jane Doe",
        email: "jane@example.com",
        when: "10:00am - Thursday, November 6, 2026 (Central European Time)",
        location: "Google Meet",
      },
      lineItems: [],
    },
    tips: [
      "Answers to your booking questions follow the location; add a field per question you ask.",
    ],
  },
  {
    id: "form-responses",
    sender: "Form builders",
    kind: "form response notifications",
    title: "Parse form response emails",
    description:
      "Turn the notification emails form builders send for each response into JSON fields: name, email, company and message.",
    intro:
      "Most form builders can email you each response. Point that notification at a mailhooks.cc address and this layout reads the answers by their labels, so the response reaches a webhook, a sheet or a chat as fields.",
    sample: {
      subject: "New response: Contact us",
      from: { name: "Forms", address: "notifications@forms.example" },
      text: [
        "You have a new response to Contact us.",
        "",
        "Name: Jane Doe",
        "Email: jane@example.com",
        "Company: Acme",
        "Message: Could you send a quote for 20 seats?",
      ].join("\n"),
    },
    layout: {
      id: "form-responses",
      name: "Form responses",
      match: {
        conditions: [{ field: "email", name: "subject", op: "contains", value: "response" }],
      },
      fields: [
        { name: "form", from: "subject", pattern: "response:[ \\t]*([^\\r\\n]+)" },
        { name: "name", from: "text", pattern: "(?m)^Name:[ \\t]*([^\\r\\n]+)" },
        { name: "email", from: "text", pattern: "(?m)^Email:\\s*(\\S+)" },
        { name: "company", from: "text", pattern: "(?m)^Company:[ \\t]*([^\\r\\n]+)" },
        { name: "message", from: "text", pattern: "(?m)^Message:[ \\t]*([^\\r\\n]+)" },
      ],
    },
    result: {
      fields: {
        form: "Contact us",
        name: "Jane Doe",
        email: "jane@example.com",
        company: "Acme",
        message: "Could you send a quote for 20 seats?",
      },
      lineItems: [],
    },
    tips: [
      "Use your form's own question labels in the patterns; a question left blank gives null.",
    ],
  },
  {
    id: "csv-reports",
    sender: "Scheduled reports",
    kind: "CSV and Excel report emails",
    title: "Parse CSV and Excel reports sent by email",
    description:
      "Turn the CSV and Excel reports your tools email on a schedule into JSON rows: each row of the attached sheet becomes a line item.",
    intro:
      "Many systems can only send a report as an emailed CSV or Excel file. This layout parses the attachment and turns each row into a line item with the columns you name, so the data reaches your webhook or a Google Sheet without anyone opening the file.",
    sample: {
      subject: "Daily sales report: 2026-10-29",
      from: { name: "Acme POS", address: "reports@acme-pos.example" },
      text: "Your daily sales report is attached.",
      attachment: "sales-2026-10-29.csv",
    },
    layout: {
      id: "csv-reports",
      name: "Sales reports",
      match: {
        conditions: [{ field: "email", name: "subject", op: "contains", value: "sales report" }],
      },
      fields: [{ name: "date", from: "subject", pattern: "(\\d{4}-\\d{2}-\\d{2})" }],
      lineItems: {
        from: "attachment",
        attachment: "*.csv",
        columns: [
          { name: "sku", column: "SKU" },
          { name: "quantity", column: "Qty" },
          { name: "revenue", column: "Revenue" },
        ],
      },
      parseAttachments: true,
    },
    result: {
      fields: { date: "2026-10-29" },
      lineItems: [
        { sku: "LS-01", quantity: "4", revenue: "156.00" },
        { sku: "CT-02", quantity: "2", revenue: "48.00" },
      ],
    },
    tips: [
      "Each started 1,000 rows of a sheet is a parsed page: a daily report of a few hundred rows uses one page a day.",
      "Excel files work the same way; name the sheet in the layout when the report has several.",
    ],
  },
  {
    id: "pdf-invoices",
    sender: "Suppliers",
    kind: "PDF invoice emails",
    title: "Parse PDF invoices sent by email",
    description:
      "Read the text of PDF invoices your suppliers email and deliver it as JSON with the invoice number from the subject, ready for your accounting workflow.",
    intro:
      "Suppliers send invoices as PDF attachments. This layout reads the invoice number from the subject and parses the PDF's text layer, so the invoice's text arrives in the delivery as `parsed.attachments[].text` for your code or an accounting tool to read.",
    sample: {
      subject: "Invoice INV-2026-0142 from Acme Supplies",
      from: { name: "Acme Supplies", address: "billing@acme-supplies.example" },
      text: "Please find invoice INV-2026-0142 attached. Payment is due in 30 days.",
      attachment: "INV-2026-0142.pdf",
    },
    layout: {
      id: "pdf-invoices",
      name: "Supplier invoices",
      match: {
        conditions: [{ field: "email", name: "subject", op: "contains", value: "Invoice" }],
      },
      fields: [
        { name: "invoice", from: "subject", pattern: "Invoice (\\S+)" },
        { name: "due", from: "text", pattern: "due in (\\d+) days" },
      ],
      parseAttachments: true,
    },
    result: {
      fields: { invoice: "INV-2026-0142", due: "30" },
      lineItems: [],
    },
    tips: [
      "Only PDFs with a text layer are read; scanned invoices without one come through as files, unparsed.",
      "Each PDF page is a parsed page.",
    ],
  },
];

export function layoutTemplate(id: string): LayoutTemplate | null {
  return LAYOUT_TEMPLATES.find((template) => template.id === id) ?? null;
}
