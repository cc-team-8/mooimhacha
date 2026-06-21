// golden-angle hue distribution: each successive index gets a maximally
// distinct hue regardless of how many members there are
const GOLDEN = 137.508;

export function avatarBg(index: number): string {
  const hue = Math.round((index * GOLDEN) % 360);
  return `linear-gradient(150deg, hsl(${hue}, 70%, 75%), hsl(${hue}, 70%, 58%))`;
}

export function memberColor(index: number): string {
  const hue = Math.round((index * GOLDEN) % 360);
  return `hsl(${hue}, 65%, 68%)`;
}
