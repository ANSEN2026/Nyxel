interface OverlapRequest {
  requestId: number;
  gridSize: number;
  triangles: Float32Array;
}

interface OverlapResponse {
  requestId: number;
  gridSize: number;
  covered: number;
  overlap: number;
  data: Uint8Array;
}

self.onmessage = (event: MessageEvent<OverlapRequest>) => {
  const { requestId, gridSize, triangles } = event.data;
  const size = Math.max(32, Math.min(1024, Math.floor(gridSize) || 512));
  const grid = new Uint16Array(size * size);
  const count = Math.floor(triangles.length / 6);

  for (let triangle = 0; triangle < count; triangle += 1) {
    const offset = triangle * 6;
    const u0 = triangles[offset];
    const v0 = triangles[offset + 1];
    const u1 = triangles[offset + 2];
    const v1 = triangles[offset + 3];
    const u2 = triangles[offset + 4];
    const v2 = triangles[offset + 5];

    const minU = Math.min(u0, u1, u2);
    const maxU = Math.max(u0, u1, u2);
    const minV = Math.min(v0, v1, v2);
    const maxV = Math.max(v0, v1, v2);
    if (maxU < 0 || minU > 1 || maxV < 0 || minV > 1) continue;

    const minX = Math.max(0, Math.floor(minU * size));
    const maxX = Math.min(size - 1, Math.floor(maxU * size));
    const minY = Math.max(0, Math.floor(minV * size));
    const maxY = Math.min(size - 1, Math.floor(maxV * size));
    if (minX > maxX || minY > maxY) continue;

    const area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (Math.abs(area) < 1e-12) continue;

    for (let y = minY; y <= maxY; y += 1) {
      const py = (y + 0.5) / size;
      const row = y * size;
      for (let x = minX; x <= maxX; x += 1) {
        const px = (x + 0.5) / size;
        const w0 = ((u1 - px) * (v2 - py) - (u2 - px) * (v1 - py)) / area;
        const w1 = ((u2 - px) * (v0 - py) - (u0 - px) * (v2 - py)) / area;
        const w2 = 1 - w0 - w1;
        // Strictly inside: shared edges must not be counted as overlap between
        // two adjacent UV triangles.
        if (w0 > 1e-6 && w1 > 1e-6 && w2 > 1e-6) grid[row + x] += 1;
      }
    }
  }

  let covered = 0;
  let overlap = 0;
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < grid.length; index += 1) {
    const hits = grid[index];
    if (!hits) continue;
    covered += 1;
    if (hits > 1) {
      overlap += 1;
      data[index * 4] = 255;
      data[index * 4 + 1] = 74;
      data[index * 4 + 2] = 74;
      data[index * 4 + 3] = 150;
    }
  }

  const response: OverlapResponse = { requestId, gridSize: size, covered, overlap, data };
  (self as unknown as {
    postMessage: (message: OverlapResponse, transfer: Transferable[]) => void;
  }).postMessage(response, [data.buffer]);
};
