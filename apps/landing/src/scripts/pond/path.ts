import { CatmullRomCurve3, Vector3 } from 'three';
import type { Point3 } from './brush';

// Where everything stands, and the walk past it. One stop per beat on the page:
// the camera stands at `eye` and frames `focus` on the side away from the text.

export const POND = { centre: new Vector3(0, 0, -32), radius: 11 };

export const PLACES = {
  brevity: new Vector3(-4.5, 0, 1),
  highlights: new Vector3(5, 0, -7),
  notes: new Vector3(-4.5, 0, -16),
  personas: new Vector3(5.5, 0, -19),
  quiz: new Vector3(-14, 0, -24),
  ripple: new Vector3(1.5, 0, -33),
  lantern: new Vector3(4.5, 0, -24.5),
  cabin: new Vector3(-1, 0, -46.5),
};

type Stop = { eye: Point3; focus: Point3; text: 'left' | 'right' };

export const STOPS: Stop[] = [
  { eye: [1, 2.2, 20], focus: [0, 1.8, 2], text: 'left' },
  { eye: [2.5, 2.4, 9], focus: [-4.5, 2.1, 1], text: 'right' },
  { eye: [-0.5, 2.5, 0.5], focus: [5, 1.4, -7], text: 'right' },
  { eye: [1.5, 2.3, -9.5], focus: [-4.5, 1.3, -16], text: 'left' },
  { eye: [-1, 2.6, -10], focus: [5.5, 1.2, -19], text: 'right' },
  { eye: [-5.5, 2.5, -14.5], focus: [-14, 2.1, -24], text: 'left' },
  { eye: [1.5, 5.5, -14], focus: [1.5, 0.3, -31], text: 'left' },
];

const UP = new Vector3(0, 1, 0);

/**
 * Where the camera looks so that the focus lands beside the text, or above it
 * when the card sits at the bottom of a narrow screen.
 */
function lookFor(stop: Stop, narrow: boolean): Vector3 {
  const eye = new Vector3(...stop.eye);
  const focus = new Vector3(...stop.focus);
  const distance = eye.distanceTo(focus);
  if (narrow) return focus.setY(focus.y - distance * 0.2);
  const right = focus.clone().sub(eye).cross(UP).normalize();
  const shift = distance * 0.24 * (stop.text === 'right' ? 1 : -1);
  return focus.addScaledVector(right, shift);
}

export function walkCurves(narrow: boolean) {
  return {
    eye: new CatmullRomCurve3(
      STOPS.map((stop) => new Vector3(...stop.eye)),
      false,
      'centripetal',
    ),
    look: new CatmullRomCurve3(
      STOPS.map((stop) => lookFor(stop, narrow)),
      false,
      'centripetal',
    ),
  };
}
