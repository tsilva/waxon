import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

// Reuse the image encoder already pinned by Next.js in pnpm-lock.yaml.
const require = createRequire(import.meta.url);
const sharp = require(require.resolve("sharp", { paths: [require.resolve("next")] }));
const source = new URL("../public/landing/practice-journal-hero.png", import.meta.url);

for (const width of [640, 828, 1342]) {
  const encoded = await sharp(source.pathname)
    .resize({ width })
    .avif({ quality: 50, effort: 7 })
    .toBuffer();
  const digest = createHash("sha256").update(encoded).digest("hex").slice(0, 12);
  const name = `practice-journal-hero-${width}.${digest}.avif`;
  await writeFile(new URL(`../public/landing/${name}`, import.meta.url), encoded);
  console.log(`${name}: ${encoded.length} bytes`);
}
