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

// Tray icons as raw RGBA for the StatusNotifierItem (no image decoding needed in Python).
// "rec" adds a red dot while the replay buffer is running; "off" is dimmed.
import { mkdirSync, writeFileSync } from "node:fs";
const trayDir = new URL("../../clipdeck/assets/", import.meta.url).pathname;
mkdirSync(trayDir, { recursive: true });
const trayBase = readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8").replace('rx="116"', 'rx="0" fill-opacity="0"');
const variants = {
  idle: trayBase,
  rec: trayBase.replace("</svg>", '<circle cx="420" cy="92" r="84" fill="#f2545b" stroke="#111318" stroke-width="22"/></svg>'),
  off: trayBase.replace("<svg ", '<svg opacity=".45" '),
};
for (const [name, svgText] of Object.entries(variants)) {
  for (const size of [22, 32, 64]) {
    const { data, info } = await sharp(Buffer.from(svgText), { density: 300 }).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    writeFileSync(`${trayDir}tray-${name}-${info.width}.rgba`, data);
  }
}
