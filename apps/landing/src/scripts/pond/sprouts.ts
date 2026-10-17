import { type Curve, type Material, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';
import { reveal } from './brush';
import { ease } from './landmarks';
import type { Palette } from './palette';

// The woods fill in as the walk reaches them, so the first view is open and
// each stretch draws itself a little way ahead: strokes are drawn base first
// while their ink darkens from the paper. Fading toward the paper colour rather
// than with real transparency keeps everything opaque, so nothing sorts wrongly.

/** How close (on the ground) the walk comes before something starts to appear. */
const REACH = 30;
/** What stands this close to the first view is there from the start. */
const START = 13;
/** Trees this far from the first view stand in from the start as a faint backdrop. */
const BACKDROP = 34;
/**
 * How far from the paper toward full ink the backdrop sits until the walk nears
 * it. A phone's tall, narrow view stacks the distance into a thin band behind
 * each shape, so there it is lighter and has half the trees.
 */
const FAINT = { wide: 0.35, narrow: 0.2 };
/** How much of the walk it takes to finish appearing. */
const GROW = 0.07;
/** Steps between paper and full ink; each is one shared material per tone. */
const LEVELS = 8;

type Tone = 'ink' | 'light' | 'deep';
type Sprout = {
  object: Object3D;
  at: number;
  /** How much ink it has before the walk reaches it: 0, or `FAINT` for the backdrop. */
  faint: number;
  meshes: [Mesh, Tone][];
  shown: number;
};

/** The walk's progress when the eye first comes within `REACH` of x, z, sampled along the walk. */
function arrival(samples: Vector3[], x: number, z: number) {
  if (Math.hypot(samples[0].x - x, samples[0].z - z) < START) return -GROW;
  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples.length; i++) {
    const distance = Math.hypot(samples[i].x - x, samples[i].z - z);
    if (distance < REACH) return i / (samples.length - 1);
    if (distance < best) [best, nearest] = [distance, i];
  }
  // Out of reach the whole way, like the far shore: done before the last stop.
  return Math.min(0.9, nearest / (samples.length - 1) - 0.35);
}

function fadedMaterials(palette: Palette) {
  const tones: Tone[] = ['ink', 'light', 'deep'];
  const steps = Object.fromEntries(
    tones.map((tone) => [
      tone,
      Array.from(
        { length: LEVELS },
        () => new MeshBasicMaterial({ side: palette.materials[tone].side }),
      ),
    ]),
  ) as Record<Tone, MeshBasicMaterial[]>;
  /** Follows the palette into dusk. */
  function sync() {
    for (const tone of tones)
      steps[tone].forEach((material, level) => {
        material.color
          .copy(palette.paper)
          .lerp(palette.materials[tone].color, (level + 1) / (LEVELS + 1));
      });
  }
  return { steps, sync };
}

export function createSprouts(palette: Palette, eye: Curve<Vector3>, narrow: boolean) {
  const samples = Array.from({ length: 241 }, (_, i) => eye.getPoint(i / 240, new Vector3()));
  const faded = fadedMaterials(palette);
  const sprouts: Sprout[] = [];
  const toneOf = (material: Material): Tone | undefined =>
    (['ink', 'light', 'deep'] as const).find((tone) => palette.materials[tone] === material);

  function show(sprout: Sprout, amount: number) {
    sprout.shown = amount;
    // The backdrop is already drawn, just faint; everything else draws itself in.
    const drawn = sprout.faint ? 1 : amount;
    const ink = sprout.faint + (1 - sprout.faint) * amount;
    sprout.object.visible = drawn > 0;
    const level = Math.floor(ink * (LEVELS + 1));
    sprout.meshes.forEach(([mesh, tone], k) => {
      mesh.material =
        level > LEVELS ? palette.materials[tone] : faded.steps[tone][Math.max(0, level - 1)];
      // Strokes draw one after another, base first; fills appear once the outline is down.
      const start = (k / sprout.meshes.length) * 0.5;
      if (tone === 'ink') reveal(mesh, (drawn - start) / 0.5);
      else mesh.visible = drawn > 0.6;
    });
  }

  return {
    /**
     * Holds `object` back until the walk comes near it; with `backdrop`, a far one
     * stands faintly in the distance meanwhile.
     */
    add(object: Object3D, backdrop = false) {
      const meshes: [Mesh, Tone][] = [];
      object.traverse((child) => {
        const tone = child instanceof Mesh ? toneOf(child.material) : undefined;
        if (tone) meshes.push([child as Mesh, tone]);
      });
      const { x, z } = object.position;
      const at = arrival(samples, x, z);
      const far = Math.hypot(samples[0].x - x, samples[0].z - z) > BACKDROP;
      const thinned = narrow && sprouts.length % 2 === 1;
      const faint = backdrop && far && !thinned ? FAINT[narrow ? 'narrow' : 'wide'] : 0;
      const sprout = { object, at, faint, meshes, shown: -1 };
      sprouts.push(sprout);
      show(sprout, ease(0, at, GROW));
    },
    update(t: number) {
      faded.sync();
      for (const sprout of sprouts) {
        const amount = ease(t, sprout.at, GROW);
        if (amount !== sprout.shown) show(sprout, amount);
      }
    },
  };
}
