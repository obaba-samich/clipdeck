// Renders the SVG app icon to the PNG sizes phones want.
import sharp from "sharp";
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../public/icons/icon.svg", import.meta.url));
const out = (n) => new URL(`../public/icons/${n}`, import.meta.url).pathname;
for (const size of [180, 192, 512]) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out(`icon-${size}.png`));
}
// Maskable: icon shrunk into the safe zone on a solid background.
const inner = await sharp(svg, { density: 384 }).resize(400, 400).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: "#111318" } })
  .composite([{ input: inner, top: 56, left: 56 }]).png().toFile(out("maskable-512.png"));
