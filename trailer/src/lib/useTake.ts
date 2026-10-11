import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender } from 'remotion';
import { loadCapture, type Capture, type ScrubOptions } from './capture';
import { loadFonts } from '../fonts/fonts';

/** Load a take (and the fonts) before any frame is captured. */
export function useTake(take: string, scrub: ScrubOptions): Capture | null {
  const [cap, setCap] = useState<Capture | null>(null);
  const [handle] = useState(() => delayRender(`loading take ${take}`));
  const key = JSON.stringify(scrub);
  useEffect(() => {
    let live = true;
    Promise.all([loadCapture(take, JSON.parse(key)), loadFonts()])
      .then(([c]) => {
        if (!live) return;
        setCap(c);
        continueRender(handle);
      })
      .catch((err) => cancelRender(err));
    return () => {
      live = false;
    };
  }, [take, key, handle]);
  return cap;
}
