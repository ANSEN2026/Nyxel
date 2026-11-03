export interface PaletteColor {
  r: number;
  g: number;
  b: number;
  hex: string;
  ratio: number;
  count: number;
  name: string;
  L: number;
  C: number;
  H: number;
}

export interface AnalyzeRequest {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  colorCount: number;
  ratioMode: 'perceptual' | 'pixel';
  ignoreNearBW: boolean;
  alphaThreshold: number;
}

export interface AnalyzeResponse {
  palette: PaletteColor[];
  labels: Uint8Array;
  width: number;
  height: number;
  transparentRatio: number;
  includedPixels: number;
  totalPixels: number;
}
