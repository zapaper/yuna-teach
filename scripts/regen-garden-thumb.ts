// Regenerate landscape_garden_thumb.webp from landscape_garden.png.
// Matches the 400x224 (16:9) format of the other habitat thumbs.
import sharp from "sharp";
import path from "path";

async function main() {
  const src = path.join(process.cwd(), "public/avatars/landscape_garden.png");
  const dst = path.join(process.cwd(), "public/avatars/landscape_garden_thumb.webp");
  await sharp(src)
    .resize(400, 224, { fit: "cover", position: "center" })
    .webp({ quality: 80 })
    .toFile(dst);
  const stat = await sharp(dst).metadata();
  console.log(`Wrote ${dst} — ${stat.width}x${stat.height}`);
}

main();
