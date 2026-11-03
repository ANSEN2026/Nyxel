export interface SharedImage {
  bitmap: ImageBitmap | HTMLCanvasElement;
  width: number;
  height: number;
  name: string;
  path: string;
}

let current: SharedImage | null = null;

export const imageStore = {
  set(image: SharedImage): void {
    current = image;
  },
  get(): SharedImage | null {
    return current;
  },
  clear(): void {
    current = null;
  }
};
