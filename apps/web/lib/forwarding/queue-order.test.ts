import { describe, expect, it } from "vitest";
import { inQueueOrder } from "./queue-order";

const row = (delivery_id: string, queued_at: string) => ({ delivery_id, queued_at });

describe("inQueueOrder", () => {
  it("orders by queue time, whatever order the rows came back in", () => {
    const rows = [
      row("c", "2026-11-13T23:04:37.300+00:00"),
      row("a", "2026-11-13T23:04:37.100+00:00"),
      row("b", "2026-11-13T23:04:37.2+00:00"),
    ];
    expect(inQueueOrder(rows).map((r) => r.delivery_id)).toEqual(["a", "b", "c"]);
  });

  it("tells apart times within the same millisecond", () => {
    const rows = [
      row("later", "2026-11-13T23:04:37.123457+00:00"),
      row("earlier", "2026-11-13T23:04:37.123456+00:00"),
      row("whole", "2026-11-13T23:04:37+00:00"),
    ];
    expect(inQueueOrder(rows).map((r) => r.delivery_id)).toEqual(["whole", "earlier", "later"]);
  });

  it("breaks ties by id, as the claim does, and leaves its input alone", () => {
    const rows = [row("b2", "2026-11-13T23:04:37Z"), row("a1", "2026-11-13T23:04:37Z")];
    expect(inQueueOrder(rows).map((r) => r.delivery_id)).toEqual(["a1", "b2"]);
    expect(rows.map((r) => r.delivery_id)).toEqual(["b2", "a1"]);
  });

  it("compares the same instant across offsets", () => {
    const rows = [
      row("utc", "2026-11-13T23:00:00.000002+00:00"),
      row("cet", "2026-11-14T00:00:00.000001+01:00"),
    ];
    expect(inQueueOrder(rows).map((r) => r.delivery_id)).toEqual(["cet", "utc"]);
  });
});
