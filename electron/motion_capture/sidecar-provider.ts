import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  MotionCaptureError,
  SKELETON_ID,
  type MotionCaptureConfig,
  type MotionCaptureContext,
  type MotionCaptureErrorCode,
  type MotionCaptureJob,
  type MotionCaptureOptions,
  type MotionCaptureProvider,
  type MotionCaptureResult,
  type MotionStage,
  type SkeletonAnimation
} from './contracts';

interface SidecarResultMessage {
  type: 'result';
  outputPath: string;
  previewPath?: string;
  duration?: number;
  skeletonId?: string;
  hasRootMotion?: boolean;
  warnings?: string[];
}

interface SidecarProgressMessage {
  type: 'progress';
  stage: MotionStage;
  percent: number;
  message?: string;
}

interface SidecarErrorMessage {
  type: 'error';
  code?: string;
  message?: string;
}

type SidecarMessage = SidecarResultMessage | SidecarProgressMessage | SidecarErrorMessage;

function safeFileStem(value: string): string {
  const stem = path.basename(value, path.extname(value)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return stem || 'video';
}

export function resolveSidecarScript(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = resourcesPath
    ? path.join(resourcesPath, 'motion-capture-sidecar', 'mocap_sidecar.py')
    : '';
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'electron', 'motion_capture', 'sidecar', 'mocap_sidecar.py');
}

export class SidecarProvider implements MotionCaptureProvider {
  readonly id = 'sidecar';

  private cancelled = new Set<string>();
  private processes = new Map<string, ChildProcess>();
  private previews = new Map<string, SkeletonAnimation>();

  constructor(
    private readonly config: MotionCaptureConfig,
    private readonly scriptOverride = ''
  ) {}

  async run(
    job: MotionCaptureJob,
    options: MotionCaptureOptions,
    context: MotionCaptureContext
  ): Promise<MotionCaptureResult> {
    const script = this.scriptOverride || resolveSidecarScript();
    if (!fs.existsSync(script)) {
      throw new MotionCaptureError('SIDECAR_NOT_FOUND', `找不到 Sidecar 脚本：${script}`);
    }

    await fs.promises.mkdir(options.outputDir, { recursive: true });
    const outputPath = path.join(
      options.outputDir,
      `${safeFileStem(job.inputPath)}_${job.jobId.slice(-8)}.bvh`
    );
    const python = this.config.pythonPath.trim() || 'python';
    const args = [
      script,
      '--input', job.inputPath,
      '--output', outputPath,
      '--fps', String(job.fps),
      '--format', options.format,
      '--device', options.device,
      '--keep-root-motion', options.keepRootMotion ? '1' : '0'
    ];
    if (options.modelDir.trim()) args.push('--model-dir', options.modelDir.trim());

    context.log(`SidecarProvider 启动：${python} ${args.join(' ')}`);
    return new Promise<MotionCaptureResult>((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = '';
      let stderr = '';
      let resultMessage: SidecarResultMessage | null = null;
      let errorMessage: SidecarErrorMessage | null = null;

      const finish = (error?: Error, result?: MotionCaptureResult): void => {
        if (settled) return;
        settled = true;
        this.processes.delete(job.jobId);
        this.cancelled.delete(job.jobId);
        if (error) reject(error);
        else if (result) resolve(result);
      };

      let child: ChildProcess;
      try {
        child = spawn(python, args, {
          cwd: path.dirname(script),
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
      } catch (error) {
        reject(new MotionCaptureError('SIDECAR_NOT_FOUND', error instanceof Error ? error.message : String(error)));
        return;
      }
      this.processes.set(job.jobId, child);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let message: SidecarMessage;
          try {
            message = JSON.parse(trimmed) as SidecarMessage;
          } catch {
            context.log(`sidecar stdout: ${trimmed}`);
            continue;
          }
          if (message.type === 'progress') {
            const percent = Math.max(0, Math.min(100, Number(message.percent) || 0));
            context.onProgress({
              jobId: job.jobId,
              stage: message.stage,
              percent,
              message: message.message || message.stage
            });
            context.log(`progress ${message.stage} ${percent}% ${message.message ?? ''}`.trim());
          } else if (message.type === 'result') {
            resultMessage = message;
            context.log(`sidecar result: ${message.outputPath}`);
          } else if (message.type === 'error') {
            errorMessage = message;
            context.log(`sidecar error: ${message.code ?? 'ERROR'} ${message.message ?? ''}`.trim());
          }
        }
      });

      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
        context.log(`sidecar stderr: ${chunk.trimEnd()}`);
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        const code: MotionCaptureErrorCode = error.code === 'ENOENT' ? 'SIDECAR_NOT_FOUND' : 'SIDECAR_CRASHED';
        finish(new MotionCaptureError(code, `无法启动 Sidecar：${error.message}`));
      });

      child.on('close', (code) => {
        if (this.cancelled.has(job.jobId) || context.isCancelled()) {
          finish(new MotionCaptureError('CANCELLED', '已取消'));
          return;
        }
        if (errorMessage) {
          const mapped = (errorMessage.code || 'SIDECAR_CRASHED') as MotionCaptureErrorCode;
          finish(new MotionCaptureError(mapped, errorMessage.message || 'Sidecar 执行失败'));
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() || `Sidecar 退出码 ${code}`;
          finish(new MotionCaptureError('SIDECAR_CRASHED', detail));
          return;
        }
        if (!resultMessage) {
          finish(new MotionCaptureError('SIDECAR_PROTOCOL', 'Sidecar 未返回结果'));
          return;
        }
        const finalPath = path.resolve(resultMessage.outputPath || outputPath);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(finalPath);
        } catch {
          finish(new MotionCaptureError('SIDECAR_PROTOCOL', 'Sidecar 没有生成 BVH 文件'));
          return;
        }
        if (!stat.isFile() || stat.size <= 0) {
          finish(new MotionCaptureError('SIDECAR_PROTOCOL', 'Sidecar 生成的 BVH 文件为空'));
          return;
        }
        if (resultMessage.previewPath) {
          const preview = this.readPreview(resultMessage.previewPath, context);
          if (preview) this.previews.set(job.jobId, preview);
        }
        finish(undefined, {
          jobId: job.jobId,
          format: 'bvh',
          outputPath: finalPath,
          fps: job.fps,
          duration: Number(resultMessage.duration) || 5,
          skeletonId: resultMessage.skeletonId || SKELETON_ID,
          hasRootMotion: resultMessage.hasRootMotion ?? options.keepRootMotion,
          warnings: Array.isArray(resultMessage.warnings) ? resultMessage.warnings : []
        });
      });
    });
  }

  async cancel(jobId: string): Promise<boolean> {
    this.cancelled.add(jobId);
    const child = this.processes.get(jobId);
    if (!child) return false;
    try {
      child.kill();
    } catch {
      // The close handler still resolves the job.
    }
    return true;
  }

  async getPreview(jobId: string): Promise<SkeletonAnimation | null> {
    return this.previews.get(jobId) ?? null;
  }

  private readPreview(previewPath: string, context: MotionCaptureContext): SkeletonAnimation | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(previewPath, 'utf8')) as SkeletonAnimation;
      if (!parsed || typeof parsed !== 'object') throw new Error('preview is not an object');
      if (!Array.isArray(parsed.joints) || parsed.joints.length !== 24) throw new Error('invalid joints');
      if (!Array.isArray(parsed.frames) || parsed.frames.length < 2) throw new Error('invalid frames');
      if (!Number.isFinite(parsed.fps) || parsed.fps <= 0) throw new Error('invalid fps');
      context.log(`preview loaded: ${previewPath} (${parsed.frames.length} frames)`);
      return parsed;
    } catch (error) {
      context.log(`preview ignored: ${previewPath} ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  dispose(): void {
    for (const child of this.processes.values()) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    this.processes.clear();
    this.cancelled.clear();
    this.previews.clear();
  }
}
