import { app, dialog, type BrowserWindow, type SaveDialogOptions, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  MotionCaptureError,
  SKELETON_ID,
  type MotionCaptureConfig,
  type MotionCaptureContext,
  type MotionCaptureErrorCode,
  type MotionCaptureExportResponse,
  type MotionCaptureJob,
  type MotionCaptureLogResponse,
  type MotionCaptureOptions,
  type MotionCaptureProgress,
  type MotionCaptureProvider,
  type MotionCaptureRunOptions,
  type MotionCaptureRunResponse,
  type MotionCaptureResult,
  type MotionCaptureRuntime,
  type SkeletonAnimation
} from './contracts';
import { MockProvider } from './mock-provider';
import { SidecarProvider, resolveSidecarScript } from './sidecar-provider';
import { writeFbx, type FbxPreset, type FbxProfile } from './fbx-export';

interface ActiveJob {
  jobId: string;
  provider: MotionCaptureProvider;
  logPath: string;
  cancelled: boolean;
  timedOut: boolean;
  timer: NodeJS.Timeout | null;
}

function jobId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function sanitizeJobId(value: string): string {
  return String(value || '').replace(/[^\w.-]/g, '_').slice(0, 120) || 'job';
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export class MotionCaptureService {
  private readonly windowProvider: () => BrowserWindow | null;
  private active = new Map<string, ActiveJob>();
  private results = new Map<string, MotionCaptureResult>();
  private previews = new Map<string, SkeletonAnimation>();
  private logPaths = new Map<string, string>();
  private configCache: MotionCaptureConfig | null = null;

  constructor(windowProvider: () => BrowserWindow | null) {
    this.windowProvider = windowProvider;
  }

  private configFile(): string {
    return path.join(app.getPath('userData'), 'motion-capture.json');
  }

  private logsDir(): string {
    return path.join(app.getPath('userData'), 'motion-capture', 'logs');
  }

  private defaultOutputDir(): string {
    return path.join(app.getPath('documents'), 'Nyxel', 'MotionCapture');
  }

  private defaultConfig(): MotionCaptureConfig {
    const provider = process.env.NYXEL_MOTION_PROVIDER === 'sidecar' ? 'sidecar' : 'mock';
    return {
      version: 1,
      provider,
      modelDir: '',
      device: 'cpu',
      outputFormat: 'bvh',
      fps: 30,
      keepRootMotion: true,
      outputDir: process.env.NYXEL_MOTION_OUTPUT_DIR
        ? path.resolve(process.env.NYXEL_MOTION_OUTPUT_DIR)
        : this.defaultOutputDir(),
      pythonPath: process.env.NYXEL_PYTHON || 'python',
      timeoutSeconds: 120
    };
  }

  private normalizeConfig(value: Partial<MotionCaptureConfig> | null | undefined): MotionCaptureConfig {
    const defaults = this.defaultConfig();
    const source = value ?? {};
    const provider = source.provider === 'sidecar' ? 'sidecar' : source.provider === 'mock' ? 'mock' : defaults.provider;
    const device = source.device === 'cuda' || source.device === 'mps' ? source.device : 'cpu';
    const outputFormat = source.outputFormat === 'fbx' ? 'fbx' : 'bvh';
    const outputDir = typeof source.outputDir === 'string' && source.outputDir.trim()
      ? path.resolve(source.outputDir.trim())
      : defaults.outputDir;
    return {
      version: 1,
      provider,
      modelDir: typeof source.modelDir === 'string' ? source.modelDir.trim() : defaults.modelDir,
      device,
      outputFormat,
      fps: clamp(Number(source.fps), 1, 120, defaults.fps),
      keepRootMotion: typeof source.keepRootMotion === 'boolean' ? source.keepRootMotion : defaults.keepRootMotion,
      outputDir,
      pythonPath: typeof source.pythonPath === 'string' && source.pythonPath.trim()
        ? source.pythonPath.trim()
        : defaults.pythonPath,
      timeoutSeconds: clamp(Number(source.timeoutSeconds), 1, 3600, defaults.timeoutSeconds)
    };
  }

  getConfig(): MotionCaptureConfig {
    if (this.configCache) return { ...this.configCache };
    try {
      if (fs.existsSync(this.configFile())) {
        const raw = stripBom(fs.readFileSync(this.configFile(), 'utf8'));
        const parsed = JSON.parse(raw) as Partial<MotionCaptureConfig>;
        this.configCache = this.normalizeConfig(parsed);
        return { ...this.configCache };
      }
    } catch (error) {
      console.warn('motion capture config read failed', error);
    }
    this.configCache = this.defaultConfig();
    return { ...this.configCache };
  }

  saveConfig(partial: Partial<MotionCaptureConfig>): MotionCaptureConfig {
    const next = this.normalizeConfig({ ...this.getConfig(), ...partial });
    fs.mkdirSync(path.dirname(this.configFile()), { recursive: true });
    fs.writeFileSync(this.configFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    this.configCache = next;
    return { ...next };
  }

  async checkRuntime(): Promise<MotionCaptureRuntime> {
    const config = this.getConfig();
    if (config.provider === 'mock') {
      return {
        ok: true,
        provider: 'mock',
        pythonPath: config.pythonPath,
        message: 'Mock 预设骨架，不需要 Python 运行时'
      };
    }

    const script = resolveSidecarScript();
    if (!fs.existsSync(script)) {
      return {
        ok: false,
        provider: 'sidecar',
        pythonPath: config.pythonPath,
        message: `找不到 Sidecar 脚本：${script}`
      };
    }

    return new Promise<MotionCaptureRuntime>((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const finish = (runtime: MotionCaptureRuntime): void => {
        if (settled) return;
        settled = true;
        resolve(runtime);
      };
      const child = spawn(config.pythonPath || 'python', [script, '--check'], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        finish({
          ok: false,
          provider: 'sidecar',
          pythonPath: config.pythonPath,
          message: 'Python 运行时检测超时'
        });
      }, 20000);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        finish({
          ok: false,
          provider: 'sidecar',
          pythonPath: config.pythonPath,
          message: error.code === 'ENOENT'
            ? `找不到 Python：${config.pythonPath}`
            : `无法启动 Python：${error.message}`
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let parsed: Record<string, unknown> | null = null;
        for (const line of stdout.split(/\r?\n/).reverse()) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const candidate = JSON.parse(trimmed) as Record<string, unknown>;
            if (candidate.type === 'runtime') {
              parsed = candidate;
              break;
            }
          } catch {
            // try the previous line
          }
        }
        if (parsed) {
          finish({
            ok: Boolean(parsed.ok),
            provider: 'sidecar',
            pythonPath: String(parsed.pythonPath || config.pythonPath),
            pythonVersion: parsed.pythonVersion ? String(parsed.pythonVersion) : undefined,
            mediapipeVersion: parsed.mediapipeVersion ? String(parsed.mediapipeVersion) : undefined,
            opencvVersion: parsed.opencvVersion ? String(parsed.opencvVersion) : undefined,
            message: parsed.message ? String(parsed.message) : undefined,
            missing: Array.isArray(parsed.missing) ? parsed.missing.map(String) : undefined
          });
          return;
        }
        finish({
          ok: false,
          provider: 'sidecar',
          pythonPath: config.pythonPath,
          message: stderr.trim() || `Python 检测退出码 ${code}`
        });
      });
    });
  }

  private logPathFor(id: string): string {
    return path.join(this.logsDir(), `${sanitizeJobId(id)}.log`);
  }

  private appendLog(logPath: string, message: string): void {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    } catch {
      // Logging must never take down a job.
    }
  }

  private remember<T>(map: Map<string, T>, id: string, value: T): void {
    map.set(id, value);
    while (map.size > 12) {
      const first = map.keys().next();
      if (first.done) break;
      map.delete(first.value);
    }
  }

  private sendProgress(sender: WebContents | undefined, progress: MotionCaptureProgress): void {
    if (sender && !sender.isDestroyed()) sender.send('motion-capture:progress', progress);
    else {
      const window = this.windowProvider();
      if (window && !window.isDestroyed()) window.webContents.send('motion-capture:progress', progress);
    }
  }

  async start(
    inputPath: string,
    options: MotionCaptureRunOptions,
    sender?: WebContents
  ): Promise<MotionCaptureRunResponse> {
    if (this.active.size > 0) {
      return {
        ok: false,
        jobId: '',
        code: 'INTERNAL_ERROR',
        error: '已有动作捕捉任务正在运行',
        logPath: ''
      };
    }

    const config = this.getConfig();
    const id = jobId();
    const logPath = this.logPathFor(id);
    this.logPaths.set(id, logPath);
    fs.mkdirSync(this.logsDir(), { recursive: true });
    this.appendLog(logPath, `收到任务：${inputPath}`);

    const resolvedInput = path.resolve(String(inputPath || ''));
    try {
      const stat = await fs.promises.stat(resolvedInput);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      const error = '找不到输入视频';
      this.appendLog(logPath, error);
      return { ok: false, jobId: id, code: 'INPUT_NOT_FOUND', error, logPath };
    }

    const fps = clamp(Number(options.fps), 1, 120, config.fps);
    const job: MotionCaptureJob = {
      jobId: id,
      inputPath: resolvedInput,
      fps,
      targetRig: options.targetRig || SKELETON_ID,
      createdAt: new Date().toISOString()
    };
    const provider: MotionCaptureProvider = config.provider === 'sidecar'
      ? new SidecarProvider(config)
      : new MockProvider();
    const runOptions: MotionCaptureOptions = {
      // Providers always produce BVH internally. config.outputFormat only
      // chooses the default format offered by the export UI (BVH or FBX).
      format: 'bvh',
      outputDir: config.outputDir,
      keepRootMotion: config.keepRootMotion,
      device: config.device,
      modelDir: config.modelDir,
      timeoutMs: config.timeoutSeconds * 1000,
      logPath
    };
    const active: ActiveJob = {
      jobId: id,
      provider,
      logPath,
      cancelled: false,
      timedOut: false,
      timer: null
    };
    this.active.set(id, active);

    const context: MotionCaptureContext = {
      onProgress: (progress) => {
        this.appendLog(logPath, `progress ${progress.stage} ${Math.round(progress.percent)}% ${progress.message}`);
        this.sendProgress(sender, progress);
      },
      log: (message) => this.appendLog(logPath, message),
      isCancelled: () => active.cancelled || active.timedOut
    };

    active.timer = setTimeout(() => {
      if (!this.active.has(id)) return;
      active.timedOut = true;
      this.appendLog(logPath, `任务超时（${config.timeoutSeconds} 秒），正在停止`);
      void provider.cancel(id);
    }, runOptions.timeoutMs);

    try {
      const result = await provider.run(job, runOptions, context);
      this.remember(this.results, id, result);
      const preview = await provider.getPreview(id);
      if (preview) this.remember(this.previews, id, preview);
      this.appendLog(logPath, `任务完成：${result.outputPath}`);
      this.sendProgress(sender, {
        jobId: id,
        stage: 'export',
        percent: 100,
        message: '分析完成'
      });
      return { ok: true, jobId: id, result, logPath };
    } catch (error) {
      let code: MotionCaptureErrorCode = error instanceof MotionCaptureError ? error.code : 'INTERNAL_ERROR';
      if (active.timedOut) code = 'TIMEOUT';
      else if (active.cancelled) code = 'CANCELLED';
      const message = code === 'CANCELLED'
        ? '已取消'
        : code === 'TIMEOUT'
          ? `任务超时（${config.timeoutSeconds} 秒）`
          : error instanceof Error
            ? error.message
            : String(error);
      this.appendLog(logPath, `任务失败 ${code}: ${message}`);
      return { ok: false, jobId: id, code, error: message, cancelled: code === 'CANCELLED', logPath };
    } finally {
      if (active.timer) clearTimeout(active.timer);
      this.active.delete(id);
    }
  }

  async cancel(id?: string): Promise<boolean> {
    const target = id ? this.active.get(id) : this.active.values().next().value as ActiveJob | undefined;
    if (!target) return false;
    target.cancelled = true;
    this.appendLog(target.logPath, '用户取消任务');
    await target.provider.cancel(target.jobId);
    return true;
  }

  async getPreview(id: string): Promise<SkeletonAnimation | null> {
    return this.previews.get(id) ?? null;
  }

  async exportResult(id: string): Promise<MotionCaptureExportResponse> {
    const result = this.results.get(id);
    if (!result) return { ok: false, error: '找不到可导出的结果' };
    let source: fs.Stats;
    try {
      source = fs.statSync(result.outputPath);
    } catch {
      return { ok: false, error: '结果文件不存在或已被移动' };
    }
    if (!source.isFile()) return { ok: false, error: '结果文件无效' };

    let target = process.env.NYXEL_MOTION_EXPORT_PATH || '';
    if (!target) {
      const window = this.windowProvider();
      const options: SaveDialogOptions = {
        title: '导出动作文件',
        defaultPath: path.join(app.getPath('documents'), 'Nyxel', path.basename(result.outputPath)),
        filters: [{ name: 'BVH 动作文件', extensions: ['bvh'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      };
      const picked = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      target = picked.filePath;
    }
    if (!target.toLowerCase().endsWith('.bvh')) target = `${target}.bvh`;
    try {
      if (path.resolve(target) !== path.resolve(result.outputPath)) {
        await fs.promises.copyFile(result.outputPath, target);
      }
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async exportFbx(
    id: string,
    preset: FbxPreset = 'unreal',
    profile: FbxProfile = 'generic'
  ): Promise<MotionCaptureExportResponse> {
    const animation = this.previews.get(id);
    if (!animation) return { ok: false, error: '找不到可导出的预览动画，请重新分析' };
    const result = this.results.get(id);
    const baseName = result
      ? `${path.basename(result.outputPath, path.extname(result.outputPath))}.fbx`
      : 'motion.fbx';

    let target = process.env.NYXEL_MOTION_EXPORT_FBX_PATH || '';
    if (!target) {
      const window = this.windowProvider();
      const options: SaveDialogOptions = {
        title: profile === 'ue5'
          ? '导出 UE5 Mannequin 兼容 FBX（Z-up）'
          : preset === 'unreal'
            ? '导出 FBX（UE / Z-up）'
            : '导出 FBX（Y-up）',
        defaultPath: path.join(app.getPath('documents'), 'Nyxel', baseName),
        filters: [{ name: 'FBX 动作文件', extensions: ['fbx'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      };
      const picked = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      target = picked.filePath;
    }
    if (!target.toLowerCase().endsWith('.fbx')) target = `${target}.fbx`;
    try {
      await writeFbx(animation, target, preset, profile);
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  getLog(id: string): MotionCaptureLogResponse {
    const logPath = this.logPaths.get(id) || this.logPathFor(id);
    try {
      const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      return { ok: true, jobId: id, path: logPath, content };
    } catch (error) {
      return {
        ok: false,
        jobId: id,
        path: logPath,
        content: '',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  dispose(): void {
    for (const active of this.active.values()) {
      if (active.timer) clearTimeout(active.timer);
      void active.provider.cancel(active.jobId);
    }
    this.active.clear();
  }
}
