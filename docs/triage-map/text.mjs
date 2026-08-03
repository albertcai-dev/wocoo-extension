// Font metrics approximation. There is no canvas in plain Node, so glyph widths
// are estimated from a small character-class table. Boxes carry generous padding,
// so a few percent of error is invisible.
const NARROW = new Set("iljtfrI.,;:'|!()[]{}-");
const WIDE = new Set('mwMW@%');

export function charWidth(ch, fontSize) {
  if (ch === ' ') return fontSize * 0.27;
  if (NARROW.has(ch)) return fontSize * 0.30;
  if (WIDE.has(ch)) return fontSize * 0.85;
  if (ch >= 'A' && ch <= 'Z') return fontSize * 0.63;
  if (ch >= '0' && ch <= '9') return fontSize * 0.56;
  return fontSize * 0.53;
}

export function measure(text, fontSize, bold = false) {
  let w = 0;
  for (const ch of text) w += charWidth(ch, fontSize);
  return bold ? w * 1.06 : w;
}

// Greedy word wrap. Hard newlines in the source are preserved as line breaks so
// authors can force list layout inside an annotation.
export function wrap(text, fontSize, maxWidth, bold = false) {
  const out = [];
  for (const hard of String(text).split('\n')) {
    const words = hard.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (measure(candidate, fontSize, bold) <= maxWidth) {
        line = candidate;
      } else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
  }
  return out;
}
