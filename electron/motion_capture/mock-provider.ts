import fs from 'node:fs';
import path from 'node:path';
import {
  MotionCaptureError,
  SKELETON_ID,
  type MotionCaptureContext,
  type MotionCaptureJob,
  type MotionCaptureOptions,
  type MotionCaptureProvider,
  type MotionCaptureResult,
  type MotionStage,
  type SkeletonAnimation
} from './contracts';
import { writeBvh } from './bvh';
import { createMockAnimation } from './skeleton';

const STAGE_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFileStem(value: string): string {
  const stem = path.basename(value, path.extname(value)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return stem || 'video';
}

export class MockProvider implements MotionCaptureProvider {
  readonly id = 'mock';

  private cancelled = new Set<string>();
  private previews = new Map<string, SkeletonAnimation>();

  async run(
    job: MotionCaptureJob,
    options: MotionCaptureOptions,
    context: MotionCaptureContext
  ): Promise<MotionCaptureResult> {
    if (options.format !== 'bvh') {
      throw new MotionCaptureError('UNSUPPORTED_FORMAT', 'Mock 后端本轮只支持导出 BVH');
    }

    try {
      const stat = await fs.promises.stat(job.inputPath);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      throw new MotionCaptureError('INPUT_NOT_FOUND', '找不到输入视频');
    }

    const emit = (stage: MotionStage, percent: number, message: string): void => {
      context.onProgress({ jobId: job.jobId, stage, percent, message });
    };
    const checkCancelled = (): void => {
      if (context.isCancelled() || this.cancelled.has(job.jobId)) {
        throw new MotionCaptureError('CANCELLED', '已取消');
      }
    };
    const step = async (stage: MotionStage, percent: number, message: string): Promise<void> => {
      checkCancelled();
      emit(stage, percent, message);
      context.log(`${stage}: ${message}`);
      await delay(STAGE_DELAY_MS);
      checkCancelled();
    };

    context.log(`MockProvider 开始：input=${job.inputPath} fps=${job.fps} format=${options.format}`);
    await step('decode', 6, '读取视频信息');
    await step('detect', 18, '检测人体区域');
    await step('track', 32, '跟踪画面中的人体');
    await step('pose2d', 48, '估计二维关节点');
    await step('pose3d', 68, '生成三维骨架');
    await step('cleanup', 84, '清理抖动并补帧');

    checkCancelled();
    emit('export', 94, '写入 BVH 文件');
    const animation = createMockAnimation(job.fps, options.keepRootMotion);
    await fs.promises.mkdir(options.outputDir, { recursive: true });
    const outputPath = path.join(
      options.outputDir,
      `${safeFileStem(job.inputPath)}_${job.jobId.slice(-8)}.bvh`
    );
    writeBvh(animation, outputPath, options.keepRootMotion);
    this.previews.set(job.jobId, animation);
    this.cancelled.delete(job.jobId);
    const warnings: string[] = [];
    if (job.targetRig !== SKELETON_ID) {
      warnings.push(`目标骨架 ${job.targetRig} 未识别，已使用 ${SKELETON_ID}`);
    }
    warnings.push('当前为 Mock 预设骨架数据，尚未使用真实模型推理');
    context.log(`BVH 已写入：${outputPath}`);
    emit('export', 100, '分析完成');
    context.log('MockProvider 完成');

    return {
      jobId: job.jobId,
      format: 'bvh',
      outputPath,
      fps: animation.fps,
      duration: animation.duration,
      skeletonId: animation.skeletonId,
      hasRootMotion: animation.hasRootMotion,
      warnings
    };
  }

  async cancel(jobId: string): Promise<boolean> {
    this.cancelled.add(jobId);
    return true;
  }

  async getPreview(jobId: string): Promise<SkeletonAnimation | null> {
    return this.previews.get(jobId) ?? null;
  }

  dispose(): void {
    this.cancelled.clear();
    this.previews.clear();
  }
}
