import {
  CircleGeometry,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Vector3,
} from 'three';
import { type Brush, flat, type Point3, reveal, upright } from './brush';
import { buildCabin } from './cabin';
import type { Palette } from './palette';
import { PLACES } from './path';

// The shape at each stop on the walk, one per Walden feature. Each takes the walk's
// progress `t` (0 to 1), the clock and the camera position. Stops sit at t = i / 6.

export type Landmark = { update(t: number, time: number, eye: Vector3): void };

const clamp = (value: number) => Math.min(1, Math.max(0, value));
/** 0 before `from`, 1 after `from + span`, eased between. */
export const ease = (t: number, from: number, span: number) => {
  const v = clamp((t - from) / span);
  return v * v * (3 - 2 * v);
};

function place(scene: Object3D, at: Vector3, facing: number): Group {
  const group = new Group();
  group.position.copy(at);
  group.rotation.y = facing;
  scene.add(group);
  return group;
}

function groundLine(brush: Brush, parent: Object3D, half: number) {
  brush.stroke(
    [
      [-half, 0.02, 0.2],
      [0, 0, 0.1],
      [half, 0.03, 0.15],
    ],
    0.035,
    { parent },
  );
}

type PebbleOptions = { count?: number; wobble?: number; material?: Material; outline?: Material };

/** A pebble: an uneven outline with a paper fill set a little off it. */
function pebble(
  brush: Brush,
  palette: Palette,
  parent: Object3D,
  rx: number,
  ry: number,
  options: PebbleOptions = {},
) {
  const { count = 12, wobble = 0.12 } = options;
  const group = new Group();
  parent.add(group);
  const outline = brush.stroke(upright(brush.loop(rx, ry, count, wobble)), 0.045, {
    closed: true,
    material: options.outline,
    parent: group,
  });
  const material =
    options.material ?? (brush.random() < 0.5 ? palette.materials.light : palette.materials.deep);
  const fill = brush.fill(brush.loop(rx * 0.96, ry * 0.92, count, wobble * 0.8), material, group);
  fill.position.set(rx * 0.16, -ry * 0.14, -0.06);
  return { group, outline, fill };
}

/** Brevity: a long, looping line fades back behind one short, firm stroke. */
function brevity(scene: Object3D, brush: Brush, palette: Palette): Landmark {
  const group = place(scene, PLACES.brevity, 0.72);
  group.scale.setScalar(1.3);
  const faint = new MeshBasicMaterial({ transparent: true, depthWrite: false });
  const ramble: Point3[] = [];
  for (let i = 0; i <= 90; i++) {
    const u = i / 90;
    const loop = u * Math.PI * 12;
    ramble.push([
      -2.1 + 4.2 * u + Math.cos(loop) * 0.38,
      2.3 + Math.sin(u * Math.PI * 3) * 0.5 + Math.sin(loop) * 0.42,
      Math.sin(u * Math.PI * 2) * 0.3 - 0.4,
    ]);
  }
  brush.stroke(ramble, 0.045, { jitter: 0.03, material: faint, parent: group });
  const short = brush.stroke(
    [
      [-0.9, 2.2, 0.3],
      [0, 2.26, 0.3],
      [0.9, 2.2, 0.3],
    ],
    0.11,
    { jitter: 0.02, parent: group },
  );
  const stop = new Mesh(new CircleGeometry(0.16, 20), palette.materials.ink);
  stop.position.set(1.35, 2.1, 0.3);
  group.add(stop);
  brush.stroke(flat(brush.loop(2.4, 1.1, 12, 0.1), 0.02), 0.03, { closed: true, parent: group });
  return {
    update(t) {
      faint.color.copy(palette.materials.ink.color);
      faint.opacity = 1 - 0.8 * ease(t, 0.08, 0.06);
      reveal(short, ease(t, 0.12, 0.04));
      stop.scale.setScalar(Math.max(0.001, ease(t, 0.155, 0.02)));
    },
  };
}

/** Highlighting: in a heap of stones, the few worth a second look are marked. */
function highlights(scene: Object3D, brush: Brush, palette: Palette): Landmark {
  const group = place(scene, PLACES.highlights, -0.6);
  const layout: [number, number, number][] = [
    [-1.15, 0.5, 0.62],
    [0, 0.5, 0.58],
    [1.15, 0.5, 0.6],
    [-0.58, 1.45, 0.52],
    [0.58, 1.45, 0.5],
    [0, 2.3, 0.42],
  ];
  const marks: Mesh[] = [];
  layout.forEach(([x, y, radius], i) => {
    const { group: stone } = pebble(brush, palette, group, radius, radius * 0.78);
    stone.position.set(x, y, brush.wander(0.15));
    if (i !== 0 && i !== 4 && i !== 5) return;
    const mark = new Mesh(new CircleGeometry(radius * 0.62, 28), palette.materials.ink);
    mark.position.z = 0.03;
    mark.scale.set(0.001, 0.001, 1);
    stone.add(mark);
    marks.push(mark);
  });
  groundLine(brush, group, 2.3);
  return {
    update(t) {
      marks.forEach((mark, i) => {
        const k = Math.max(0.001, ease(t, 0.25 + i * 0.03, 0.03));
        mark.scale.set(k, k * 0.8, 1);
      });
    },
  };
}

/**
 * Notes: stones settle one at a time; the last arrives as an outline, like a
 * suggestion waiting in grey, and only fills in once it is taken.
 */
function notes(scene: Object3D, brush: Brush, palette: Palette): Landmark {
  const group = place(scene, PLACES.notes, 0.85);
  const pending = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const ghost = new MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false });
  const radii = [1.1, 0.85, 0.62, 0.42];
  const stones: { group: Group; rest: number }[] = [];
  let top = 0;
  let suggestion: ReturnType<typeof pebble> | undefined;
  radii.forEach((radius, i) => {
    const half = radius * 0.55;
    const last = i === radii.length - 1;
    const stone = pebble(
      brush,
      palette,
      group,
      radius,
      half,
      last ? { material: pending, outline: ghost } : {},
    );
    const rest = top + half;
    top = rest + half;
    stone.group.position.y = rest;
    if (last) suggestion = stone;
    else stones.push({ group: stone.group, rest });
  });
  groundLine(brush, group, 1.9);
  return {
    update(t) {
      stones.forEach(({ group: stone, rest }, i) => {
        if (i === 0) return;
        const k = ease(t, 0.39 + i * 0.025, 0.04);
        stone.position.y = rest + (1 - k) * 2;
        stone.rotation.z = (1 - k) * 0.6 * (i % 2 ? 1 : -1);
        stone.visible = k > 0.02;
      });
      if (!suggestion) return;
      // Waits as a grey outline at this stop, and is taken as the reader walks on.
      reveal(suggestion.outline, ease(t, 0.45, 0.025));
      const taken = ease(t, 0.525, 0.02);
      ghost.color.copy(palette.materials.ink.color);
      ghost.opacity = 0.35 + 0.65 * taken;
      pending.color.copy(palette.materials.deep.color);
      pending.opacity = taken;
    },
  };
}

/** Personas: three different companions, each coming to stand in turn. */
function personas(scene: Object3D, brush: Brush, palette: Palette): Landmark {
  const group = place(scene, PLACES.personas, -0.62);
  const shapes: [number, number, PebbleOptions][] = [
    [0.6, 1.15, {}],
    [0.8, 0.95, { count: 6, wobble: 0.3 }],
    [0.55, 0.62, {}],
  ];
  const seats = shapes.map(([rx, ry, options], i) => {
    const { group: seat } = pebble(brush, palette, group, rx, ry, options);
    const rest = ry;
    seat.position.set(-2 + i * 2, rest, brush.wander(0.3));
    return { seat, rest };
  });
  groundLine(brush, group, 3.4);
  return {
    update(t) {
      seats.forEach(({ seat, rest }, i) => {
        const k = ease(t, 0.58 + i * 0.025, 0.04);
        seat.position.y = rest - (1 - k) * rest * 0.9;
        seat.scale.y = 0.1 + 0.9 * k;
        seat.visible = k > 0.01;
      });
    },
  };
}

/** Quizzing: a closed, solid answer shrinks to the dot under a question. */
function quiz(scene: Object3D, brush: Brush, palette: Palette): Landmark {
  const group = place(scene, PLACES.quiz, 0.9);
  const answer = new Mesh(new CircleGeometry(1.3, 40), palette.materials.ink);
  const raised = new Vector3(0, 2.4, 0);
  const dot = new Vector3(0, 0.45, 0);
  answer.position.copy(raised);
  group.add(answer);
  const curl: Point3[] = [];
  for (let i = 0; i <= 30; i++) {
    const u = i / 30;
    const angle = Math.PI * (1.05 - 1.6 * u);
    curl.push([Math.cos(angle) * 1.15, 3.3 + Math.sin(angle) * 1.05, Math.sin(u * Math.PI) * 0.5]);
  }
  curl.push([0.05, 1.55, 0.1], [0, 1.15, 0]);
  const stroke = brush.stroke(curl, 0.09, { jitter: 0.05, parent: group });
  brush.stroke(flat(brush.loop(1.9, 1.2, 12, 0.1), 0.02), 0.03, { closed: true, parent: group });
  return {
    update(t) {
      // The answer only appears as the reader nears, so it isn't a dark blot seen
      // through the trees from earlier stops.
      const k = ease(t, 0.73, 0.09);
      answer.position.lerpVectors(raised, dot, k);
      answer.scale.setScalar(Math.max(0.001, (1 - 0.84 * k) * ease(t, 0.6, 0.07)));
      reveal(stroke, ease(t, 0.76, 0.07));
    },
  };
}

/**
 * Conversations fade, notes stay: rings spread across the pond and fade out,
 * open like the Walden mark, while the cabin keeps its light.
 */
function ripples(scene: Object3D, brush: Brush, palette: Palette): Landmark {
  const group = place(scene, PLACES.ripple, 0);
  const dot = new Mesh(new CircleGeometry(0.28, 20), palette.materials.ink);
  dot.rotation.x = -Math.PI / 2;
  dot.position.y = 0.08;
  group.add(dot);
  const rings = [0, 1, 2].map(() => {
    const material = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    const ring = new Group();
    group.add(ring);
    const arc: Point3[] = [];
    for (let k = 0; k <= 16; k++) {
      const angle = 0.5 + (k / 16) * Math.PI * 1.65;
      arc.push([Math.cos(angle), 0.06, Math.sin(angle)]);
    }
    brush.stroke(arc, 0.03, { jitter: 0.04, material, parent: ring });
    return { ring, material };
  });
  return {
    update(t, time) {
      const presence = 0.35 + 0.65 * ease(t, 0.89, 0.1);
      rings.forEach(({ ring, material }, i) => {
        const age = (time * 0.12 + i / 3) % 1;
        ring.scale.set(0.6 + age * 7, 1, 0.6 + age * 6.2);
        ring.rotation.y = i * 2.1 + time * 0.05;
        material.color.copy(palette.materials.ink.color);
        material.opacity = (1 - age) ** 1.5 * presence;
      });
    },
  };
}

/** A lamp on the shore that comes on at dusk. */
function lantern(scene: Object3D, brush: Brush, palette: Palette): Landmark {
  const group = place(scene, PLACES.lantern, 0);
  brush.stroke(
    [
      [0, 0, 0],
      [0.02, 0.9, 0],
      [0, 1.4, 0],
    ],
    0.03,
    { parent: group },
  );
  brush.stroke(
    upright([
      [-0.18, 1.4],
      [-0.18, 1.85],
      [0.18, 1.85],
      [0.18, 1.4],
    ]),
    0.025,
    { closed: true, jitter: 0.01, parent: group },
  );
  const glow = new Mesh(new CircleGeometry(0.42, 28), palette.materials.lantern);
  glow.position.y = 1.62;
  group.add(glow);
  return {
    update(t, _time, eye) {
      palette.materials.lantern.opacity = ease(t, 0.89, 0.1) * 0.75;
      glow.lookAt(eye);
    },
  };
}

export function buildLandmarks(scene: Object3D, brush: Brush, palette: Palette): Landmark[] {
  return [
    brevity(scene, brush, palette),
    highlights(scene, brush, palette),
    notes(scene, brush, palette),
    personas(scene, brush, palette),
    quiz(scene, brush, palette),
    ripples(scene, brush, palette),
    lantern(scene, brush, palette),
    buildCabin(scene, brush, palette),
  ];
}
