import {
  BufferGeometry,
  CircleGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  type Object3D,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import { type Brush, flat, type Point3, upright } from './brush';
import { ease } from './landmarks';
import { dotTexture, type Palette } from './palette';
import { POND, type walkCurves } from './path';
import { buildWoods, isClear } from './woods';

// Everything around the stops: the pond, the far hills, a sun that sets, the
// woods (woods.ts), the footpath, and stars.

type Curves = ReturnType<typeof walkCurves>;

function horizon(brush: Brush) {
  for (let k = 0; k < 3; k++) {
    const points: Point3[] = [];
    const z = -80 - k * 10;
    const amplitude = 4 + k * 2.5;
    for (let x = -130; x <= 130; x += 13)
      points.push([
        x,
        Math.max(0, Math.sin(x * 0.035 + k * 1.7) * amplitude + amplitude * 0.6 + brush.wander(2)),
        z + brush.wander(4),
      ]);
    brush.stroke(points, 0.16 + k * 0.04, { jitter: 0.6 });
  }
}

function sun(scene: Object3D, brush: Brush, palette: Palette) {
  const group = new Group();
  group.position.set(18, 26, -100);
  scene.add(group);
  brush.stroke(upright(brush.loop(7, 7, 18, 0.05)), 0.16, { closed: true, parent: group });
  const disc = new Mesh(new CircleGeometry(6.6, 32), palette.materials.light);
  disc.position.set(1.2, -0.8, -0.3);
  group.add(disc);
  for (let i = 0; i < 11; i++) {
    const angle = (i / 11) * Math.PI * 2;
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    brush.stroke(
      [
        [c * 8.6, s * 8.6, 0],
        [c * 11, s * 11, 0],
      ],
      0.14,
      { parent: group },
    );
  }
  return group;
}

function pond(scene: Object3D, brush: Brush, palette: Palette) {
  const group = new Group();
  group.position.copy(POND.centre);
  scene.add(group);
  const rim = brush.loop(POND.radius, POND.radius * 0.92, 22, 0.05);
  brush.stroke(flat(rim, 0.05), 0.08, { closed: true, parent: group });
  const water = brush.fill(
    rim.map(([x, z]) => [x * 0.97, z * 0.97]),
    palette.materials.water,
    group,
  );
  water.rotation.x = Math.PI / 2;
  water.position.set(0.6, 0.02, 0.4);
  // A few reeds at the water's edge.
  for (let i = 0; i < 9; i++) {
    const angle = Math.PI * (0.15 + brush.random() * 0.7) + (i % 2 ? Math.PI : 0);
    const x = Math.cos(angle) * POND.radius * 1.02;
    const z = Math.sin(angle) * POND.radius * 0.94;
    const height = 1.2 + brush.random() * 1.2;
    brush.stroke(
      [
        [x, 0, z],
        [x + brush.wander(0.4), height * 0.6, z],
        [x + brush.wander(0.6), height, z],
      ],
      0.03,
      {
        parent: group,
      },
    );
  }
}

/** Stepping stones under the walk, and a little hatching on the ground. */
function footpath(brush: Brush, walk: Vector3[]) {
  for (const at of walk.filter((point) => point.y < 3)) {
    const stone = brush
      .loop(0.42, 0.3, 9, 0.15)
      .map(([x, z]): [number, number] => [at.x + x, at.z + z]);
    brush.stroke(flat(stone, 0.03), 0.025, { closed: true });
  }
  for (let i = 0; i < 40; i++) {
    const x = brush.wander(60);
    const z = 24 - brush.random() * 74;
    if (!isClear(x, z, walk, 0)) continue;
    const length = 1 + brush.random() * 2.5;
    brush.stroke(
      [
        [x, 0.02, z],
        [x + length / 2, 0.02, z + 0.1],
        [x + length, 0.02, z],
      ],
      0.028,
    );
  }
}

function stars(scene: Object3D, palette: Palette) {
  const positions: number[] = [];
  for (let i = 0; i < 380; i++) {
    const around = Math.random() * Math.PI * 2;
    const up = Math.acos(Math.random() * 0.9);
    positions.push(
      Math.cos(around) * Math.sin(up) * 95,
      Math.cos(up) * 95 + 4,
      Math.sin(around) * Math.sin(up) * 95 - 30,
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const material = new PointsMaterial({
    color: palette.starColor,
    size: 1.6,
    map: dotTexture(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  scene.add(new Points(geometry, material));
  return material;
}

export function buildLandscape(scene: Object3D, brush: Brush, palette: Palette, curves: Curves) {
  // Evenly spaced along the walk, about a stride apart.
  const walk = curves.eye.getSpacedPoints(Math.round(curves.eye.getLength() / 1.7));
  horizon(brush);
  const setting = sun(scene, brush, palette);
  pond(scene, brush, palette);
  const woods = buildWoods(scene, brush, palette, walk);
  footpath(brush, walk);
  const night = stars(scene, palette);
  return {
    update(t: number, time: number) {
      setting.position.y = 26 - t * 26;
      night.opacity = ease(t, 0.87, 0.12) * 0.85;
      woods.update(t, time);
    },
  };
}
