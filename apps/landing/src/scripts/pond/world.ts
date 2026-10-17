import { Fog, Group, PerspectiveCamera, Scene, Timer, Vector3, WebGLRenderer } from 'three';
import type { Story } from '../story';
import { createBrush, seeded } from './brush';
import { buildLandmarks } from './landmarks';
import { buildLandscape } from './landscape';
import { createPalette } from './palette';
import { walkCurves } from './path';

// The pond walk: a fixed canvas behind the page whose camera follows the scroll.

const NARROW = matchMedia('(max-width: 720px)');
const DARK = matchMedia('(prefers-color-scheme: dark)');

function buildScene(canvas: HTMLCanvasElement) {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  const small = Math.min(innerWidth, innerHeight) < 600;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 2));
  const scene = new Scene();
  const palette = createPalette();
  scene.fog = new Fog(palette.paper, 30, 140);
  const strokes = new Group();
  scene.add(strokes);
  const brush = createBrush(seeded(11), palette.materials.ink, strokes);
  const curves = walkCurves(NARROW.matches);
  const landscape = buildLandscape(strokes, brush, palette, curves, NARROW.matches);
  const landmarks = buildLandmarks(strokes, brush, palette);
  return { renderer, scene, palette, landscape, landmarks };
}

/** A camera that walks the path, leaning a little toward the pointer. */
function createWalker(story: Story) {
  const camera = new PerspectiveCamera(45, 1, 0.1, 400);
  const pointer = { x: 0, y: 0 };
  const eased = { x: 0, y: 0, t: story.progress() };
  const eye = new Vector3();
  const look = new Vector3();
  let curves = walkCurves(NARROW.matches);

  addEventListener(
    'pointermove',
    (event) => {
      pointer.x = event.clientX / innerWidth - 0.5;
      pointer.y = event.clientY / innerHeight - 0.5;
    },
    { passive: true },
  );

  return {
    camera,
    eye,
    resize() {
      camera.aspect = innerWidth / innerHeight;
      camera.fov = camera.aspect < 0.8 ? 62 : 45;
      camera.updateProjectionMatrix();
      curves = walkCurves(NARROW.matches);
    },
    /** Steps toward the scroll position; returns the eased progress and whether it has arrived. */
    step() {
      const target = story.progress();
      eased.t += (target - eased.t) * (story.reducedMotion ? 1 : 0.07);
      if (Math.abs(target - eased.t) < 1e-4) eased.t = target;
      curves.eye.getPoint(eased.t, eye);
      curves.look.getPoint(eased.t, look);
      if (!story.reducedMotion) {
        eased.x += (pointer.x - eased.x) * 0.05;
        eased.y += (pointer.y - eased.y) * 0.05;
        look.x += eased.x * 1.2;
        look.y -= eased.y * 0.6;
      }
      camera.position.copy(eye);
      camera.lookAt(look);
      return { t: eased.t, arrived: eased.t === target };
    },
  };
}

const ramp = (t: number, from: number, span: number) => Math.min(1, Math.max(0, (t - from) / span));

export function startWorld(canvas: HTMLCanvasElement, story: Story) {
  const { renderer, scene, palette, landscape, landmarks } = buildScene(canvas);
  const walker = createWalker(story);
  const timer = new Timer();
  let frame = 0;

  /** Draws one frame; returns whether the camera has caught up with the scroll. */
  function draw(): boolean {
    timer.update();
    const { t, arrived } = walker.step();
    // Dark mode stays at dusk the whole walk; light mode reaches it at the pond.
    const dusk = DARK.matches ? 1 : ramp(t, 0.86, 0.13);
    palette.setNight(dusk * dusk * (3 - 2 * dusk));
    palette.setLit(ramp(t, 0.87, 0.11));
    renderer.setClearColor(palette.paper);
    scene.fog?.color.copy(palette.paper);
    const time = story.reducedMotion ? 0 : timer.getElapsed();
    landscape.update(t, time);
    for (const landmark of landmarks) landmark.update(t, time, walker.eye);
    renderer.render(scene, walker.camera);
    return arrived;
  }

  // With reduced motion nothing moves on its own, so draw only while the page does.
  function tick() {
    const arrived = draw();
    frame = story.reducedMotion && arrived ? 0 : requestAnimationFrame(tick);
  }
  const wake = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    walker.resize();
    wake();
  };

  addEventListener('resize', resize);
  DARK.addEventListener('change', wake);
  story.subscribe(wake);
  resize();
}
