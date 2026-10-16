import { CanvasTexture, Color, DoubleSide, MeshBasicMaterial, SRGBColorSpace } from 'three';

// One warm hue at a few values. At dusk paper and ink trade places, and the page's
// CSS colours follow so the cards stay legible over the scene.

const pair = (day: number, night: number) => [new Color(day), new Color(night)] as const;

const COLORS = {
  paper: pair(0xf3ece1, 0x241c17),
  ink: pair(0x3b2b21, 0xede2d0),
  /** Body text on the cards: dark enough to read at length over the paper. */
  muted: pair(0x5c4f45, 0xcdc0af),
  light: pair(0xe7daca, 0x30261f),
  deep: pair(0xd9c7b0, 0x3d3027),
  water: pair(0xe2d3bf, 0x2c231d),
  glow: pair(0xe7daca, 0xd9a464),
};

export type Palette = ReturnType<typeof createPalette>;

export function createPalette() {
  const solid = (color: Color) => new MeshBasicMaterial({ color, side: DoubleSide });
  const materials = {
    ink: solid(COLORS.ink[0].clone()),
    light: solid(COLORS.light[0].clone()),
    deep: solid(COLORS.deep[0].clone()),
    water: solid(COLORS.water[0].clone()),
    glow: solid(COLORS.glow[0].clone()),
    lantern: new MeshBasicMaterial({
      color: COLORS.glow[1].clone(),
      side: DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  };
  const paper = COLORS.paper[0].clone();
  const muted = new Color();
  const root = document.documentElement.style;
  let applied = -1;

  /** Moves every colour `night` (0 to 1) of the way to dusk. */
  function setNight(night: number) {
    const amount = Math.round(night * 200) / 200;
    if (amount === applied) return;
    applied = amount;
    paper.copy(COLORS.paper[0]).lerp(COLORS.paper[1], amount);
    materials.ink.color.copy(COLORS.ink[0]).lerp(COLORS.ink[1], amount);
    materials.light.color.copy(COLORS.light[0]).lerp(COLORS.light[1], amount);
    materials.deep.color.copy(COLORS.deep[0]).lerp(COLORS.deep[1], amount);
    materials.water.color.copy(COLORS.water[0]).lerp(COLORS.water[1], amount);
    muted.copy(COLORS.muted[0]).lerp(COLORS.muted[1], amount);
    // Colors work in linear space; CSS wants sRGB channels.
    const { r, g, b } = paper.getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
    root.setProperty('--paper', `#${paper.getHexString()}`);
    root.setProperty('--ink', `#${materials.ink.color.getHexString()}`);
    root.setProperty('--muted', `#${muted.getHexString()}`);
    root.setProperty(
      '--halo',
      `rgb(${[r, g, b].map((v) => Math.round(v * 255)).join(' ')} / 0.95)`,
    );
  }

  /** Lights a material from its daylight tone toward lamplight. */
  function setLit(amount: number) {
    materials.glow.color.copy(COLORS.light[0]).lerp(COLORS.glow[1], amount);
  }

  return { materials, paper, starColor: COLORS.ink[1], setNight, setLit };
}

/** A soft round dot, so stars and fireflies aren't drawn as squares. */
export function dotTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);
  }
  return new CanvasTexture(canvas);
}
