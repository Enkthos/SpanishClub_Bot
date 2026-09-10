import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { gameConfig } from "../src/config";
import { renderTerritoryMap } from "../src/territory-map";

describe("territory map renderer", () => {
  it("returns a valid PNG with barrio color overlays", async () => {
    const base = await sharp({
      create: { width: 1312, height: 1200, channels: 3, background: "#777777" },
    }).png().toBuffer();
    const rendered = await renderTerritoryMap(
      new Uint8Array(base),
      { "1": "nomadas", "2": "navegantes", "3": "lumieres", "4": "fuegos", "5": "panteras" },
      gameConfig,
    );
    const metadata = await sharp(rendered).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1312);
    expect(metadata.height).toBe(1200);
  });
});
