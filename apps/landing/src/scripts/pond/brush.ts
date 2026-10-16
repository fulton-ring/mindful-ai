import {
  CatmullRomCurve3,
  type Material,
  Mesh,
  type Object3D,
  Shape,
  ShapeGeometry,
  TubeGeometry,
  Vector3,
} from 'three';

// Hand-drawn strokes in 3D: a jittered spline swept into a tube whose width swells
// and tapers like a brush, plus flat paper fills set slightly off their outlines.

export type Point3 = [number, number, number];
export type Point2 = [number, number];

export type StrokeOptions = {
  closed?: boolean;
  /** How far each control point may wander; defaults to a little more than the radius. */
  jitter?: number;
  material?: Material;
  parent?: Object3D;
};

const RADIAL_SEGMENTS = 5;

/** A seeded random source, so the scene is drawn the same way on every visit. */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** Narrows the tube near its ends (open strokes) or lets it breathe (closed loops). */
function shapeWidth(
  geometry: TubeGeometry,
  curve: CatmullRomCurve3,
  segments: number,
  closed: boolean,
  phase: number,
) {
  const positions = geometry.attributes.position;
  const centre = new Vector3();
  const vertex = new Vector3();
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    curve.getPointAt(u, centre);
    const scale = closed
      ? 0.75 + 0.3 * Math.sin(u * Math.PI * 4 + phase)
      : 0.22 + 0.95 * Math.sin(Math.PI * u) ** 0.45;
    for (let k = 0; k <= RADIAL_SEGMENTS; k++) {
      const index = i * (RADIAL_SEGMENTS + 1) + k;
      vertex.fromBufferAttribute(positions, index).sub(centre).multiplyScalar(scale).add(centre);
      positions.setXYZ(index, vertex.x, vertex.y, vertex.z);
    }
  }
  positions.needsUpdate = true;
}

export type Brush = ReturnType<typeof createBrush>;

export function createBrush(random: () => number, ink: Material, root: Object3D) {
  const wander = (amount: number) => (random() - 0.5) * amount;

  function stroke(points: Point3[], radius: number, options: StrokeOptions = {}): Mesh {
    const closed = options.closed ?? false;
    const jitter = options.jitter ?? radius * 1.2;
    const curve = new CatmullRomCurve3(
      points.map(
        ([x, y, z]) => new Vector3(x + wander(jitter), y + wander(jitter), z + wander(jitter)),
      ),
      closed,
      'centripetal',
    );
    const segments = Math.max(10, Math.min(260, Math.round(curve.getLength() * 7)));
    const geometry = new TubeGeometry(curve, segments, radius, RADIAL_SEGMENTS, closed);
    shapeWidth(geometry, curve, segments, closed, random() * 6);
    const mesh = new Mesh(geometry, options.material ?? ink);
    (options.parent ?? root).add(mesh);
    return mesh;
  }

  /** An uneven ellipse in the XY plane. */
  function loop(rx: number, ry: number, count = 14, wobble = 0.08): Point2[] {
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      return [
        Math.cos(angle) * rx * (1 + wander(wobble)),
        Math.sin(angle) * ry * (1 + wander(wobble)),
      ];
    });
  }

  function fill(points: Point2[], material: Material, parent: Object3D = root): Mesh {
    const shape = new Shape();
    shape.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) shape.lineTo(x, y);
    shape.closePath();
    const mesh = new Mesh(new ShapeGeometry(shape), material);
    parent.add(mesh);
    return mesh;
  }

  return { random, wander, stroke, loop, fill };
}

/** Lifts XY points into the XZ plane at height `y`, for shapes lying on the ground. */
export const flat = (points: Point2[], y = 0): Point3[] => points.map(([x, z]) => [x, y, z]);

/** Stands XY points up at depth `z`. */
export const upright = (points: Point2[], z = 0): Point3[] => points.map(([x, y]) => [x, y, z]);

/** Shows the first `amount` (0 to 1) of a stroke, so it appears to be drawn. */
export function reveal(mesh: Mesh, amount: number) {
  const index = mesh.geometry.index;
  if (!index) return;
  const per = RADIAL_SEGMENTS * 6;
  const segments = index.count / per;
  mesh.geometry.setDrawRange(0, Math.round(segments * Math.min(1, Math.max(0, amount))) * per);
  mesh.visible = amount > 0.001;
}
