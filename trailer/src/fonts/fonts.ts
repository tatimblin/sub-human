/**
 * Bundled fonts, so a render never depends on what the machine has installed (all SIL OFL 1.1, licences
 * beside the files): JetBrains Mono for the terminals; Noto Sans Symbols 2 / Symbols / Math subsets for the
 * glyphs Claude Code draws that JetBrains Mono lacks (⏺ ⎿ ⏵ ✻ ✢ ✳ ✽ ⧉ …); Inter for titles and captions.
 * Subsets, cut with `pyftsubset <font> --unicodes=<ranges> --flavor=woff2` (Inter also `--layout-features='*'`):
 *   NotoSansSymbols2  U+2190-21FF,U+2300-23FF,U+25A0-25FF,U+2600-27BF,U+2B00-2BFF
 *   NotoSansSymbols   U+2300-23FF,U+2600-26FF
 *   NotoSansMath      U+2900-2AFF,U+25A0-25FF
 *   Inter (variable)  U+0000-00FF,U+2010-205F,U+2190-2193,U+20AC,U+2122,U+2715,U+00D7
 * JetBrains Mono is the unmodified v2.304 webfont.
 */
import { loadFont } from '@remotion/fonts';
import monoRegular from './JetBrainsMono-Regular.woff2';
import monoBold from './JetBrainsMono-Bold.woff2';
import monoItalic from './JetBrainsMono-Italic.woff2';
import symbols2 from './NotoSansSymbols2-subset.woff2';
import symbols from './NotoSansSymbols-subset.woff2';
import math from './NotoSansMath-subset.woff2';
import inter from './Inter-var-latin.woff2';

export const MONO = "'JetBrains Mono', 'TrailerSymbols2', 'TrailerSymbols', 'TrailerMath'";
export const SANS = "'Inter', 'TrailerSymbols2'";

let loaded: Promise<unknown> | null = null;

/** Load every face once; callers hold a delayRender until it settles. */
export function loadFonts() {
  loaded ||= Promise.all([
    loadFont({ family: 'JetBrains Mono', url: monoRegular, weight: '400' }),
    loadFont({ family: 'JetBrains Mono', url: monoBold, weight: '700' }),
    loadFont({ family: 'JetBrains Mono', url: monoItalic, weight: '400', style: 'italic' }),
    loadFont({ family: 'TrailerSymbols2', url: symbols2 }),
    loadFont({ family: 'TrailerSymbols', url: symbols }),
    loadFont({ family: 'TrailerMath', url: math }),
    loadFont({ family: 'Inter', url: inter, weight: '100 900' }),
  ]);
  return loaded;
}
