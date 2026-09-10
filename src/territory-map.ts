import sharp from "sharp";
import type { GameConfig } from "./types";

// Normalized polygons align with the 15 claimable regions on the supplied map.
// Aeropuerto San Cielo is intentionally excluded because it is not in the legend.
const POLYGONS: Record<string, [number, number][]> = {
  "1": [[.29,.27],[.34,.10],[.52,.08],[.52,.30],[.44,.43],[.31,.43]], // Monte Claro
  "2": [[.52,.07],[.73,.05],[.74,.29],[.63,.36],[.52,.30]], // Cerro Rojo
  "3": [[.74,.08],[.91,.13],[.95,.35],[.82,.43],[.72,.29]], // Tierra Nueva
  "4": [[.18,.31],[.34,.29],[.36,.48],[.18,.48]], // La Vista
  "5": [[.34,.35],[.48,.34],[.49,.54],[.31,.54]], // El Corona
  "6": [[.47,.33],[.63,.30],[.66,.53],[.49,.54]], // Los Olvidados
  "7": [[.61,.29],[.74,.34],[.73,.53],[.64,.54]], // Santa Fortuna
  "8": [[.43,.51],[.68,.50],[.68,.67],[.48,.69]], // Pueblo Viejo
  "9": [[.72,.43],[.86,.42],[.86,.62],[.70,.61]], // Del Valle
  "10": [[.85,.40],[.97,.43],[.96,.64],[.85,.66]], // Las Palmas
  "11": [[.69,.59],[.87,.59],[.86,.75],[.70,.75]], // East Heights
  "12": [[.25,.79],[.43,.68],[.51,.81],[.38,.90],[.24,.89]], // Bahía Flats
  "13": [[.32,.56],[.51,.58],[.51,.76],[.35,.79]], // Los Jardines
  "14": [[.49,.67],[.70,.63],[.72,.84],[.53,.87]], // Río Sur
  "15": [[.68,.76],[.88,.72],[.87,.91],[.67,.92]], // Puerto Sol
};

export async function renderTerritoryMap(
  baseImage: Uint8Array,
  territories: Record<string, string | null>,
  config: GameConfig,
): Promise<Uint8Array> {
  const image = sharp(baseImage);
  const metadata = await image.metadata();
  const width = metadata.width ?? 1312;
  const height = metadata.height ?? 1200;
  const shapes = Object.entries(POLYGONS).map(([zone, points]) => {
    const owner = territories[zone];
    const color = config.barrios.find((barrio) => barrio.id === owner)?.color;
    if (!color) return "";
    const coordinates = points.map(([x, y]) => `${Math.round(x * width)},${Math.round(y * height)}`).join(" ");
    return `<polygon points="${coordinates}" fill="${color}" fill-opacity="0.43" stroke="${color}" stroke-width="5"/>`;
  }).join("");
  const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`);
  return new Uint8Array(await image.composite([{ input: overlay }]).png().toBuffer());
}
