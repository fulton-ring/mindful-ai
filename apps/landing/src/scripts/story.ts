// The page's scroll story: how far along the walk the reader is, which card is in
// focus, and the chat lines revealing. The pond scene reads `progress()`.

export type Story = {
  /** 0 at the first beat, 1 at the last, linear between beat centres. */
  progress(): number;
  /** Called after every scroll or resize update. */
  subscribe(listener: () => void): void;
  reducedMotion: boolean;
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** Scroll offsets at which each beat's centre sits in the middle of the viewport. */
function measureAnchors(sections: HTMLElement[]): number[] {
  const viewport = innerHeight;
  const max = document.documentElement.scrollHeight - viewport;
  const anchors = sections.map((section) =>
    clamp(section.offsetTop + section.offsetHeight / 2 - viewport / 2, 0, max),
  );
  anchors[0] = 0;
  anchors[anchors.length - 1] = max;
  return anchors;
}

function progressAt(scroll: number, anchors: number[]): number {
  const last = anchors.length - 1;
  if (scroll <= anchors[0]) return 0;
  for (let index = 0; index < last; index++) {
    if (scroll > anchors[index + 1]) continue;
    const span = Math.max(1, anchors[index + 1] - anchors[index]);
    return (index + (scroll - anchors[index]) / span) / last;
  }
  return 1;
}

/** Fades each card by its distance from the viewport centre and returns the nearest beat. */
function placeCards(sections: HTMLElement[], anchors: number[], reducedMotion: boolean): number {
  const viewport = innerHeight;
  const last = sections.length - 1;
  let active = 0;
  let nearest = Number.POSITIVE_INFINITY;
  sections.forEach((section, index) => {
    const card = section.querySelector<HTMLElement>('.card');
    if (!card) return;
    const box = section.getBoundingClientRect();
    const distance = (box.top + box.height / 2 - viewport / 2) / (viewport * 0.8);
    if (Math.abs(distance) < nearest) {
      nearest = Math.abs(distance);
      active = index;
    }
    let opacity = clamp(1 - distance * distance * 1.7);
    if (index === 0 && scrollY < 4) opacity = 1;
    if (index === last && scrollY >= anchors[last] - 4) opacity = 1;
    card.style.opacity = opacity.toFixed(3);
    card.style.transform = reducedMotion ? 'none' : `translateY(${(distance * 24).toFixed(1)}px)`;
    card.style.visibility = opacity < 0.02 ? 'hidden' : 'visible';
  });
  return active;
}

function revealChat(lines: HTMLElement[]) {
  const section = lines[0]?.closest('section');
  if (!section) return;
  const box = section.getBoundingClientRect();
  const read = (innerHeight * 0.75 - box.top) / box.height;
  lines.forEach((line, index) => {
    line.classList.toggle('shown', read > 0.18 + index * 0.1);
  });
}

export function startStory(): Story {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sections = [...document.querySelectorAll<HTMLElement>('.beat')];
  const rail = [...document.querySelectorAll<HTMLAnchorElement>('.rail a')];
  const lines = [...document.querySelectorAll<HTMLElement>('.say')];
  const logo = document.querySelector<HTMLElement>('.logo');
  const listeners: (() => void)[] = [];
  let anchors = measureAnchors(sections);

  const update = () => {
    const active = placeCards(sections, anchors, reducedMotion);
    rail.forEach((link, index) => {
      if (index === active) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    });
    revealChat(lines);
    // The first page already says "Walden" in large type; the header logo joins
    // once that title is on its way out.
    logo?.classList.toggle('shown', progressAt(scrollY, anchors) > 0.1);
    for (const listener of listeners) listener();
  };
  const remeasure = () => {
    anchors = measureAnchors(sections);
    update();
  };

  // Beat links land on the beat's centre, where its card is fully in view.
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-beat-link]')) {
    link.addEventListener('click', (event) => {
      const index = sections.findIndex((section) => `#${section.id}` === link.hash);
      if (index < 0) return;
      event.preventDefault();
      scrollTo({ top: anchors[index], behavior: reducedMotion ? 'auto' : 'smooth' });
      history.replaceState(null, '', link.hash);
    });
  }

  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', remeasure);
  addEventListener('load', remeasure);
  update();

  return {
    progress: () => progressAt(scrollY, anchors),
    subscribe: (listener) => listeners.push(listener),
    reducedMotion,
  };
}
