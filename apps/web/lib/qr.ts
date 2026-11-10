import { encode } from "uqr";

/**
 * A QR code's dark modules as one SVG path, a run of them to a rectangle,
 * with the light border a camera needs. Drawn wherever it is shown, so no
 * link is sent to a third party to draw it.
 */
export function qrPath(text: string): { size: number; d: string } {
  const { data, size } = encode(text, { ecc: "M", border: 2 });
  let d = "";
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return { size, d };
}
