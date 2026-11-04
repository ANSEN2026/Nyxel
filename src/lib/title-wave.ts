import { audioMonitor } from './audio-monitor';

export function startTitleWave(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  let raf = 0;
  let tick = 0;

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const draw = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) {
      raf = requestAnimationFrame(draw);
      return;
    }
    ctx.clearRect(0, 0, width, height);
    const active = audioMonitor.isActive;
    const frequency = audioMonitor.readFrequency();
    const barWidth = 2;
    const gap = 2;
    const barCount = Math.max(18, Math.floor(width / (barWidth + gap)));
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, 'rgba(79, 191, 143, 0.34)');
    gradient.addColorStop(0.55, 'rgba(143, 255, 196, 0.8)');
    gradient.addColorStop(1, 'rgba(216, 255, 233, 0.96)');
    ctx.fillStyle = gradient;
    ctx.shadowColor = 'rgba(111, 255, 184, 0.45)';
    ctx.shadowBlur = active ? 7 : 2;

    for (let index = 0; index < barCount; index += 1) {
      let amplitude: number;
      if (active) {
        const bin = Math.min(
          frequency.length - 1,
          Math.floor(Math.pow(index / barCount, 1.65) * frequency.length * 0.7)
        );
        amplitude = Math.max(0.025, frequency[bin] / 255);
      } else {
        amplitude = 0.06 + Math.max(0, Math.sin(tick * 0.018 + index * 0.34)) * 0.08;
      }
      const barHeight = Math.max(1.5, amplitude * (height - 2));
      const x = index * (barWidth + gap);
      ctx.globalAlpha = active ? 0.42 + amplitude * 0.58 : 0.32;
      ctx.fillRect(x, height - barHeight, barWidth, barHeight);
    }

    ctx.globalAlpha = 0.5;
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(160, 255, 208, 0.28)';
    ctx.fillRect(0, height - 1, width, 1);
    ctx.globalAlpha = 1;
    tick += 1;
    raf = requestAnimationFrame(draw);
  };

  resize();
  window.addEventListener('resize', resize);
  raf = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
  };
}
