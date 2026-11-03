/// <reference lib="webworker" />

import type { AnalyzeRequest, AnalyzeResponse, PaletteColor } from './color-types';

interface Lab {
  L: number;
  a: number;
  b: number;
}

interface Pixel {
  r: number;
  g: number;
  b: number;
  alpha: number;
  lab: Lab;
}

interface Center {
  lab: Lab;
  count: number;
}

function srgbToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const channel = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(channel * 255)));
}

function rgbToOklab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  };
}

function oklabToRgb(lab: Lab): { r: number; g: number; b: number } {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) };
}

function distance(a: Lab, b: Lab): number {
  const dl = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
}

function average(items: Pixel[]): Lab {
  let L = 0;
  let a = 0;
  let b = 0;
  for (const item of items) {
    L += item.lab.L;
    a += item.lab.a;
    b += item.lab.b;
  }
  const n = Math.max(1, items.length);
  return { L: L / n, a: a / n, b: b / n };
}

function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function isNearBW(lab: Lab, chroma: number): boolean {
  return lab.L < 0.08 || (lab.L > 0.95 && chroma < 0.04);
}

function colorName(lab: Lab): string {
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  const hue = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
  if (chroma < 0.025) {
    if (lab.L < 0.16) return '黑';
    if (lab.L < 0.36) return '深灰';
    if (lab.L < 0.68) return '灰';
    if (lab.L < 0.9) return '浅灰';
    return '白';
  }
  let base = '红';
  if (hue < 15 || hue >= 345) base = '红';
  else if (hue < 45) base = '橙';
  else if (hue < 75) base = '黄';
  else if (hue < 105) base = '黄绿';
  else if (hue < 150) base = '绿';
  else if (hue < 180) base = '青绿';
  else if (hue < 210) base = '青';
  else if (hue < 260) base = '蓝';
  else if (hue < 300) base = '蓝紫';
  else if (hue < 330) base = '紫';
  else base = '品红';
  if (lab.L < 0.32) return `深${base}`;
  if (lab.L > 0.78) return `浅${base}`;
  return base;
}

function medianCut(pixels: Pixel[], count: number): Lab[] {
  if (!pixels.length) return [];
  let boxes: Pixel[][] = [pixels];
  while (boxes.length < count) {
    let bestIndex = -1;
    let bestRange = -1;
    let bestAxis: 'L' | 'a' | 'b' = 'L';
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.length < 2) continue;
      let minL = Infinity;
      let maxL = -Infinity;
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const item of box) {
        minL = Math.min(minL, item.lab.L);
        maxL = Math.max(maxL, item.lab.L);
        minA = Math.min(minA, item.lab.a);
        maxA = Math.max(maxA, item.lab.a);
        minB = Math.min(minB, item.lab.b);
        maxB = Math.max(maxB, item.lab.b);
      }
      const ranges: Array<['L' | 'a' | 'b', number]> = [
        ['L', maxL - minL],
        ['a', maxA - minA],
        ['b', maxB - minB]
      ];
      for (const [axis, range] of ranges) {
        if (range > bestRange) {
          bestRange = range;
          bestIndex = i;
          bestAxis = axis;
        }
      }
    }
    if (bestIndex < 0) break;
    const box = boxes[bestIndex];
    box.sort((left, right) => left.lab[bestAxis] - right.lab[bestAxis]);
    const middle = Math.floor(box.length / 2);
    const first = box.slice(0, middle);
    const second = box.slice(middle);
    boxes.splice(bestIndex, 1, first, second);
  }
  return boxes.map(average);
}

function kmeans(pixels: Pixel[], initial: Lab[], iterations = 10): Center[] {
  if (!pixels.length || !initial.length) return [];
  let centers = initial.map((lab) => ({ lab, count: 0 }));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sums = centers.map(() => ({ L: 0, a: 0, b: 0, count: 0 }));
    for (const pixel of pixels) {
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < centers.length; i += 1) {
        const d = distance(pixel.lab, centers[i].lab);
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      const sum = sums[best];
      sum.L += pixel.lab.L;
      sum.a += pixel.lab.a;
      sum.b += pixel.lab.b;
      sum.count += 1;
    }
    centers = centers.map((center, index) => {
      const sum = sums[index];
      if (!sum.count) return { lab: center.lab, count: 0 };
      return {
        lab: { L: sum.L / sum.count, a: sum.a / sum.count, b: sum.b / sum.count },
        count: sum.count
      };
    });
  }

  return centers;
}

function mergeCenters(centers: Center[]): Center[] {
  const sorted = [...centers].sort((a, b) => b.count - a.count);
  const merged: Center[] = [];
  for (const center of sorted) {
    const existing = merged.find((candidate) => distance(candidate.lab, center.lab) < 0.0025);
    if (existing) {
      const total = existing.count + center.count;
      if (total > 0) {
        existing.lab = {
          L: (existing.lab.L * existing.count + center.lab.L * center.count) / total,
          a: (existing.lab.a * existing.count + center.lab.a * center.count) / total,
          b: (existing.lab.b * existing.count + center.lab.b * center.count) / total
        };
        existing.count = total;
      }
    } else {
      merged.push({ lab: { ...center.lab }, count: center.count });
    }
  }
  return merged;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage: (message: AnalyzeResponse, transfer?: Transferable[]) => void;
};

scope.onmessage = (event) => {
  const { pixels, width, height, colorCount, ratioMode, ignoreNearBW, alphaThreshold } = event.data;
  const totalPixels = width * height;
  const threshold = Math.max(0, Math.min(1, alphaThreshold)) * 255;

  const palettePixels: Pixel[] = [];
  let transparentCount = 0;
  let ignoredCount = 0;

  for (let i = 0; i < totalPixels; i += 1) {
    const offset = i * 4;
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    if (alpha < threshold) {
      transparentCount += 1;
      continue;
    }
    const lab = rgbToOklab(r, g, b);
    const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
    if (ratioMode === 'perceptual' && ignoreNearBW && isNearBW(lab, chroma)) {
      ignoredCount += 1;
      continue;
    }
    palettePixels.push({ r, g, b, alpha, lab });
  }

  if (!palettePixels.length) {
    scope.postMessage({
      palette: [],
      labels: new Uint8Array(totalPixels),
      width,
      height,
      transparentRatio: totalPixels ? transparentCount / totalPixels : 0,
      includedPixels: 0,
      totalPixels
    });
    return;
  }

  const initial = medianCut(palettePixels, colorCount);
  const centers = mergeCenters(kmeans(palettePixels, initial));
  const finalCenters = centers.length ? centers : [{ lab: average(palettePixels), count: palettePixels.length }];

  const counts = new Array(finalCenters.length).fill(0);
  for (const pixel of palettePixels) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < finalCenters.length; i += 1) {
      const d = distance(pixel.lab, finalCenters[i].lab);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    counts[best] += 1;
  }

  const entries = finalCenters.map((center, originalIndex) => {
    const rgb = oklabToRgb(center.lab);
    const chroma = Math.sqrt(center.lab.a * center.lab.a + center.lab.b * center.lab.b);
    const hue = ((Math.atan2(center.lab.b, center.lab.a) * 180) / Math.PI + 360) % 360;
    return {
      originalIndex,
      center,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      hex: hexOf(rgb.r, rgb.g, rgb.b),
      ratio: counts[originalIndex] / palettePixels.length,
      count: counts[originalIndex],
      name: colorName(center.lab),
      L: center.lab.L,
      C: chroma,
      H: hue
    };
  }).sort((left, right) => right.ratio - left.ratio);

  const palette: PaletteColor[] = entries.map((entry) => ({
    r: entry.r,
    g: entry.g,
    b: entry.b,
    hex: entry.hex,
    ratio: entry.ratio,
    count: entry.count,
    name: entry.name,
    L: entry.L,
    C: entry.C,
    H: entry.H
  }));
  const sortedIndex = new Map<number, number>();
  entries.forEach((entry, index) => sortedIndex.set(entry.originalIndex, index));

  const labels = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i += 1) {
    const offset = i * 4;
    const alpha = pixels[offset + 3];
    if (alpha < threshold) continue;
    const lab = rgbToOklab(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
    if (ratioMode === 'perceptual' && ignoreNearBW && isNearBW(lab, chroma)) continue;
    let best = 0;
    let bestDistance = Infinity;
    for (let c = 0; c < finalCenters.length; c += 1) {
      const d = distance(lab, finalCenters[c].lab);
      if (d < bestDistance) {
        bestDistance = d;
        best = c;
      }
    }
    labels[i] = (sortedIndex.get(best) ?? 0) + 1;
  }

  scope.postMessage(
    {
      palette,
      labels,
      width,
      height,
      transparentRatio: totalPixels ? transparentCount / totalPixels : 0,
      includedPixels: palettePixels.length,
      totalPixels
    },
    [labels.buffer]
  );
};

export {};
