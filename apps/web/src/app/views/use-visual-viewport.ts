import { useEffect } from 'react';

export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty('--visible-viewport-height', `${viewport.height}px`);
      root.style.setProperty('--visible-viewport-top', `${viewport.offsetTop}px`);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--visible-viewport-height');
      root.style.removeProperty('--visible-viewport-top');
    };
  }, []);
}
