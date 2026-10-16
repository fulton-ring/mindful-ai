import { Group, type Object3D } from 'three';
import type { Brush, Point3 } from './brush';
import type { Landmark } from './landmarks';
import type { Palette } from './palette';
import { PLACES } from './path';

// The cabin on the far shore, drawn in one continuous line with paper planes set
// a little off it. Its window lights at dusk and smoke curls from the chimney.

const OUTLINE: Point3[] = [
  [-2.5, 0, 2],
  [-2.55, 3, 2],
  [0, 5.2, 2],
  [2.5, 3, 2],
  [2.5, 0, 2],
  [1.4, 0, 2],
  [1.4, 1.9, 2],
  [0.4, 1.92, 2],
  [0.4, 0, 2],
  [-2.6, 0, 2],
];

/** The paper planes behind the line: front, side, and the window that lights. */
function paperPlanes(brush: Brush, { materials }: Palette, cabin: Group) {
  const front = brush.fill(
    [
      [-2.5, 0],
      [-2.5, 3],
      [0, 5.2],
      [2.5, 3],
      [2.5, 0],
    ],
    materials.light,
    cabin,
  );
  front.position.set(0.35, -0.15, 1.97);
  const side = brush.fill(
    [
      [-2, 0],
      [-2, 3],
      [2, 3],
      [2, 0],
    ],
    materials.deep,
    cabin,
  );
  side.rotation.y = Math.PI / 2;
  side.position.set(2.48, 0.2, -0.3);
  const glass = brush.fill(
    [
      [-0.45, -0.45],
      [-0.45, 0.45],
      [0.45, 0.45],
      [0.45, -0.45],
    ],
    materials.glow,
    cabin,
  );
  glass.position.set(-1.25, 1.75, 2);
}

function chimneySmoke(brush: Brush, cabin: Group): Group {
  const smoke = new Group();
  smoke.position.set(1.42, 5.7, -0.8);
  cabin.add(smoke);
  const curl: Point3[] = [];
  for (let i = 0; i <= 50; i++) {
    const u = i / 50;
    const angle = u * Math.PI * 6;
    const radius = 0.1 + u * 0.6;
    curl.push([Math.cos(angle) * radius - u * 0.6, u * 3.4, Math.sin(angle) * radius]);
  }
  brush.stroke(curl, 0.035, { parent: smoke, jitter: 0.02 });
  return smoke;
}

export function buildCabin(scene: Object3D, brush: Brush, palette: Palette): Landmark {
  const cabin = new Group();
  cabin.position.copy(PLACES.cabin);
  cabin.rotation.y = 0.35;
  cabin.scale.setScalar(1.15);
  scene.add(cabin);
  const line = { jitter: 0.05, parent: cabin };
  brush.stroke(OUTLINE, 0.07, line);
  brush.stroke(
    [
      [2.5, 0, 2],
      [2.5, 0, -2],
      [2.5, 3, -2],
      [2.5, 3, 2],
    ],
    0.06,
    line,
  );
  brush.stroke(
    [
      [0, 5.2, 2],
      [0.05, 5.2, 0],
      [0, 5.2, -2],
      [2.5, 3, -2],
    ],
    0.06,
    line,
  );
  brush.stroke(
    [
      [1.1, 4.2, -0.8],
      [1.1, 5.5, -0.8],
      [1.75, 5.5, -0.8],
      [1.75, 3.8, -0.8],
    ],
    0.05,
    line,
  );
  const pane: Point3[] = [
    [-1.75, 1.35, 2.03],
    [-1.75, 2.25, 2.03],
    [-0.85, 2.25, 2.03],
    [-0.85, 1.35, 2.03],
  ];
  brush.stroke(pane, 0.04, { ...line, closed: true, jitter: 0.03 });
  brush.stroke(
    [
      [-1.3, 1.35, 2.04],
      [-1.3, 2.25, 2.04],
    ],
    0.025,
    { ...line, jitter: 0.01 },
  );

  paperPlanes(brush, palette, cabin);
  const smoke = chimneySmoke(brush, cabin);

  return {
    update(_t, time) {
      smoke.rotation.y = time * 0.5;
    },
  };
}
