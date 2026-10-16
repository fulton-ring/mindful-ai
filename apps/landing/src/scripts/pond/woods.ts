import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  type Object3D,
  Points,
  PointsMaterial,
  type Vector3,
} from 'three';
import { type Brush, type Point3, upright } from './brush';
import { ease } from './landmarks';
import { dotTexture, type Palette } from './palette';
import { PLACES, POND, STOPS } from './path';
import type { createSprouts } from './sprouts';

// The woods the pond hides in: a wall of trees around the far shore, more along
// both sides of the walk, and the small things underfoot. Nothing grows on the
// path or between the camera and what it stops to look at.

type Woods = {
  brush: Brush;
  palette: Palette;
  scene: Object3D;
  sprouts: ReturnType<typeof createSprouts>;
};

const segmentDistance = (x: number, z: number, a: Point3, b: Point3) => {
  const [dx, dz] = [b[0] - a[0], b[2] - a[2]];
  const along = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (a[0] + dx * along), z - (a[2] + dz * along));
};

/** Whether something of `size` can stand at x, z without blocking the walk or a view. */
export function isClear(x: number, z: number, walk: Vector3[], size = 1): boolean {
  if (Math.hypot(x - POND.centre.x, (z - POND.centre.z) / 0.92) < POND.radius + 1.5 + size)
    return false;
  for (const at of Object.values(PLACES))
    if (Math.hypot(x - at.x, z - at.z) < 3.5 + size) return false;
  for (const at of walk) if (Math.hypot(x - at.x, z - at.z) < 2.5 + size) return false;
  // Keep each view open, and a glade behind each shape so it stands clear of the trees.
  for (const { eye } of STOPS)
    if (Math.hypot(x - eye[0], z - eye[2]) < 5 + size * 1.5) return false;
  for (const { eye, focus } of STOPS.slice(1)) {
    const beyond: Point3 = [focus[0] * 1.7 - eye[0] * 0.7, 0, focus[2] * 1.7 - eye[2] * 0.7];
    if (segmentDistance(x, z, eye, beyond) < 2.6 + size) return false;
  }
  return true;
}

function shade(woods: Woods, group: Group, outline: [number, number][]) {
  const { brush, palette } = woods;
  const material = brush.random() < 0.5 ? palette.materials.light : palette.materials.deep;
  const fill = brush.fill(outline, material, group);
  fill.position.set(brush.wander(0.6), brush.wander(0.3), -0.15);
}

function zigzagPine(woods: Woods, group: Group, height: number) {
  const { brush } = woods;
  brush.stroke(
    [
      [0, 0, 0],
      [0.03, height * 0.5, 0],
      [0, height, 0],
    ],
    0.05,
    { parent: group },
  );
  const count = 6 + Math.floor(brush.random() * 3);
  const points: Point3[] = [];
  for (let k = 0; k <= count; k++) {
    const width = 1.5 * (1 - k / count) + 0.08;
    points.push([(k % 2 ? 1 : -1) * width, 0.9 + ((height - 0.9) * k) / count, 0]);
  }
  brush.stroke(points, 0.04, { jitter: 0.06, parent: group });
  if (brush.random() < 0.6)
    shade(woods, group, [
      [-1.4, 0.9],
      [1.5, 0.8],
      [0.05, height + 0.2],
    ]);
}

function spiralPine(woods: Woods, group: Group, height: number) {
  const { brush } = woods;
  brush.stroke(
    [
      [0, 0, 0],
      [0, 0.9, 0],
    ],
    0.05,
    { parent: group },
  );
  const turns = 3.5 + brush.random() * 1.5;
  const points: Point3[] = [];
  for (let i = 0; i <= 44; i++) {
    const u = i / 44;
    const angle = u * turns * Math.PI * 2;
    const radius = 1.35 * (1 - u) + 0.06;
    points.push([Math.cos(angle) * radius, 0.8 + u * (height - 0.8), Math.sin(angle) * radius]);
  }
  brush.stroke(points, 0.04, { jitter: 0.06, parent: group });
  if (brush.random() < 0.5)
    shade(woods, group, [
      [-1.4, 0.9],
      [1.5, 0.8],
      [0.05, height + 0.2],
    ]);
}

/** A broadleaf: a trunk that forks, under a crown scribbled round twice. */
function roundTree(woods: Woods, group: Group, height: number) {
  const { brush } = woods;
  const crown = height * 0.68;
  brush.stroke(
    [
      [0, 0, 0],
      [0.05, crown * 0.6, 0],
      [-0.1, crown, 0],
    ],
    0.07,
    { parent: group },
  );
  brush.stroke(
    [
      [0.04, crown * 0.55, 0],
      [0.5, crown * 0.85, 0.05],
    ],
    0.04,
    { parent: group },
  );
  const rx = 1.5 + brush.random() * 0.5;
  const ry = height * 0.3;
  for (let pass = 0; pass < 2; pass++) {
    const loop = brush.loop(rx * (1 - pass * 0.12), ry * (1 - pass * 0.1), 11, 0.18);
    brush.stroke(upright(loop.map(([x, y]) => [x + pass * 0.2, y + crown + pass * 0.15])), 0.04, {
      closed: true,
      parent: group,
    });
  }
  shade(
    woods,
    group,
    brush.loop(rx * 0.95, ry * 0.9, 11, 0.1).map(([x, y]) => [x, y + crown]),
  );
}

/** A birch: a pale, straight trunk ticked with dark marks. */
function birch(woods: Woods, group: Group, height: number) {
  const { brush } = woods;
  const top = height * 1.1;
  brush.stroke(
    [
      [0, 0, 0],
      [0.06, top * 0.5, 0],
      [0.02, top, 0],
    ],
    0.05,
    { parent: group },
  );
  for (let k = 0; k < 5; k++) {
    const y = 0.6 + (k / 5) * top * 0.8;
    brush.stroke(
      [
        [-0.12, y, 0.05],
        [0.12, y + 0.04, 0.05],
      ],
      0.022,
      { parent: group, jitter: 0.02 },
    );
  }
  for (const side of [-1, 1]) {
    const y = top * (0.6 + brush.random() * 0.2);
    brush.stroke(
      [
        [0, y, 0],
        [side * 0.9, y + 0.8, 0],
        [side * 1.2, y + 1.5, 0],
      ],
      0.03,
      {
        parent: group,
      },
    );
  }
}

const KINDS = [zigzagPine, spiralPine, roundTree, birch, zigzagPine, spiralPine];

function plantTree(woods: Woods, x: number, z: number, scale: number) {
  const { brush, scene } = woods;
  const group = new Group();
  group.position.set(x, 0, z);
  group.scale.setScalar(scale);
  group.rotation.y = brush.wander(0.9);
  scene.add(group);
  const kind = KINDS[Math.floor(brush.random() * KINDS.length)];
  kind(woods, group, 4.2 + brush.random() * 1.4);
  woods.sprouts.add(group, true);
}

/** Tries random spots from `spot` until `count` trees stand. */
function scatter(
  count: number,
  spot: () => [number, number, number],
  plant: (x: number, z: number, scale: number) => boolean,
) {
  let placed = 0;
  for (let tries = 0; placed < count && tries < count * 60; tries++) {
    const [x, z, scale] = spot();
    if (plant(x, z, scale)) placed++;
  }
}

function forest(woods: Woods, walk: Vector3[]) {
  const { brush } = woods;
  const plant = (x: number, z: number, scale: number) => {
    if (!isClear(x, z, walk, scale)) return false;
    plantTree(woods, x, z, scale);
    return true;
  };
  // A wall of trees around the far shore, so the pond sits in a clearing.
  scatter(
    70,
    () => {
      const angle = Math.PI * (0.95 + brush.random() * 1.1);
      const reach = POND.radius + 4 + brush.random() * 14;
      return [
        POND.centre.x + Math.cos(angle) * reach * 1.15,
        POND.centre.z + Math.sin(angle) * reach,
        1 + brush.random() * 0.6,
      ];
    },
    plant,
  );
  // Woods on both sides of the walk in.
  scatter(
    90,
    () => {
      const side = brush.random() < 0.5 ? -1 : 1;
      return [
        side * (3 + brush.random() * 26),
        24 - brush.random() * 50,
        0.8 + brush.random() * 0.7,
      ];
    },
    plant,
  );
  // A few on the near shore, either side of the last view.
  scatter(
    14,
    () => {
      const side = brush.random() < 0.5 ? -1 : 1;
      return [
        side * (12 + brush.random() * 10),
        -20 - brush.random() * 10,
        0.9 + brush.random() * 0.5,
      ];
    },
    plant,
  );
}

/** Grass tufts and a few rocks between the trees. */
function undergrowth(woods: Woods, walk: Vector3[]) {
  const { brush } = woods;
  for (let i = 0; i < 160; i++) {
    const x = brush.wander(70);
    const z = 26 - brush.random() * 80;
    if (!isClear(x, z, walk, -1.2)) continue;
    if (brush.random() < 0.85) {
      const tuft = new Group();
      tuft.position.set(x, 0, z);
      woods.scene.add(tuft);
      const lean = brush.wander(0.4);
      for (const spread of [-0.25, 0, 0.25])
        brush.stroke(
          [
            [0, 0, 0],
            [spread * 1.6 + lean, 0.45 + brush.random() * 0.35, 0],
          ],
          0.018,
          { jitter: 0.03, parent: tuft },
        );
      woods.sprouts.add(tuft);
    } else {
      const rock = new Group();
      rock.position.set(x, 0.25, z);
      woods.scene.add(rock);
      brush.stroke(upright(brush.loop(0.5, 0.28, 9, 0.2)), 0.03, { closed: true, parent: rock });
      shade(woods, rock, brush.loop(0.48, 0.26, 9, 0.1));
      woods.sprouts.add(rock);
    }
  }
}

/** Lily pads: open rings, each with its notch, floating on the water. */
function lilies(woods: Woods) {
  const { brush } = woods;
  for (let i = 0; i < 9; i++) {
    const angle = brush.random() * Math.PI * 2;
    const reach = POND.radius * (0.45 + brush.random() * 0.4);
    const [cx, cz] = [Math.cos(angle) * reach, Math.sin(angle) * reach * 0.9];
    const size = 0.35 + brush.random() * 0.3;
    const notch = brush.random() * Math.PI * 2;
    const arc: Point3[] = [];
    for (let k = 0; k <= 10; k++) {
      const a = notch + 0.4 + (k / 10) * (Math.PI * 2 - 0.8);
      arc.push([Math.cos(a) * size, 0.07, Math.sin(a) * size]);
    }
    arc.push([0, 0.07, 0]);
    const pad = new Group();
    pad.position.set(POND.centre.x + cx, 0, POND.centre.z + cz);
    woods.scene.add(pad);
    brush.stroke(arc, 0.022, { closed: true, jitter: 0.02, parent: pad });
  }
}

/** Fireflies over the near shore, out at dusk. */
function fireflies(woods: Woods) {
  const { brush, scene } = woods;
  const base: number[] = [];
  for (let i = 0; i < 40; i++)
    base.push(brush.wander(26), 0.5 + brush.random() * 2.2, POND.centre.z + 6 + brush.wander(16));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(base.slice(), 3));
  const material = new PointsMaterial({
    color: 0xd9a464,
    size: 0.3,
    map: dotTexture(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  scene.add(new Points(geometry, material));
  return (t: number, time: number) => {
    material.opacity = ease(t, 0.89, 0.1) * (0.6 + 0.4 * Math.sin(time * 3));
    const positions = geometry.attributes.position;
    for (let i = 0; i < positions.count; i++)
      positions.setY(i, base[i * 3 + 1] + Math.sin(time * 1.3 + i) * 0.25);
    positions.needsUpdate = true;
  };
}

export function buildWoods(
  scene: Object3D,
  brush: Brush,
  palette: Palette,
  walk: Vector3[],
  sprouts: ReturnType<typeof createSprouts>,
) {
  const woods = { brush, palette, scene, sprouts };
  forest(woods, walk);
  undergrowth(woods, walk);
  lilies(woods);
  const flies = fireflies(woods);
  return {
    update(t: number, time: number) {
      sprouts.update(t);
      flies(t, time);
    },
  };
}
