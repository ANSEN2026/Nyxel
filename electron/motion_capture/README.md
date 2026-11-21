# 动作捕捉模块

从视频生成 24 关节人体骨架动作，并导出 BVH / FBX。

- `MockProvider`：内置预设骨架，不依赖 Python，用于界面和链路自测。
- `SidecarProvider`：调用独立 Python 进程，使用 MediaPipe Pose 做真实姿态推理。
- 任务内部先生成 BVH 供预览；导出时可选择 BVH、FBX（UE5 Mannequin 兼容重定向）、
  FBX（UE / Z-up）或 FBX（Y-up）。

主程序不导入 torch、onnxruntime、mediapipe、OpenCV 或任何 Python 包。

## 目录

```text
electron/motion_capture/
  contracts.ts          数据契约、24 关节定义、Provider 接口
  skeleton.ts           Mock 走路/呼吸动画与四元数工具
  bvh.ts                BVH 写出与 ZXY 欧拉角转换
  fbx-export.ts         FBX 二进制导出，UE Z-up / 通用 Y-up
  ue5-profile.ts        24 关节 -> UE5 Mannequin 25 骨骼重定向骨架
  UE5-RETARGET.md       UE5 IK Retargeter 操作步骤
  mock-provider.ts      默认 Mock Provider
  sidecar-provider.ts   独立 Python 子进程 Provider、预览解析
  service.ts            任务、配置、进度、取消、超时、日志、运行时检测
  sidecar/
    mocap_sidecar.py    MediaPipe 真实推理 + BVH / 预览输出
    requirements.txt    Python 依赖
src/motion_capture/
  view.ts               动作捕捉工作区
  preview.ts            Three.js 24 关节预览
tests/
  motion-capture.test.mjs       单元 / 协议 / 超时测试
  motion-capture-real.test.mjs  可选的真实 MediaPipe 集成测试
```

## 数据流

```text
渲染进程 UI
  → preload window.nyxel.motionCapture
  → electron/main.ts IPC
  → MotionCaptureService
      ├─ MockProvider
      └─ SidecarProvider → python mocap_sidecar.py → MediaPipe Pose
```

## 数据契约

- Job：`jobId`、`inputPath`、`fps`、`targetRig`、`createdAt`
- Progress：`jobId`、`stage`、`percent`、`message`
- Stage：`decode`、`detect`、`track`、`pose2d`、`pose3d`、`cleanup`、`export`
- Result：`jobId`、`format`、`outputPath`、`fps`、`duration`、`skeletonId`、
  `hasRootMotion`、`warnings`

旋转使用四元数 `[x, y, z, w]`，位移单位为米，内部坐标系为 Y-up。MediaPipe
world landmarks 的 x 向右、y 向下、z 朝向相机；Sidecar 转换为 `(x, -y, -z)`。

### 24 关节

需求列出的 21 个关节全部保留，另外增加 `root`（root motion）和左右
`clavicle` 连接骨，共 24 个：

```text
root, hips, spine, chest, neck, head,
l_clavicle, l_shoulder, l_upperarm, l_forearm, l_hand,
r_clavicle, r_shoulder, r_upperarm, r_forearm, r_hand,
l_upperleg, l_lowerleg, l_foot, l_toe,
r_upperleg, r_lowerleg, r_foot, r_toe
```

## 配置

配置文件：`%APPDATA%\Nyxel\motion-capture.json`

```json
{
  "version": 1,
  "provider": "sidecar",
  "modelDir": "",
  "device": "cpu",
  "outputFormat": "fbx",
  "fps": 30,
  "keepRootMotion": false,
  "outputDir": "C:\\Users\\<user>\\Documents\\Nyxel\\MotionCapture",
  "pythonPath": "C:\\Users\\<user>\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
  "timeoutSeconds": 600
}
```

设置页「动作捕捉」可以修改推理后端、Python 路径、模型目录、设备、默认导出格式、
帧率、root motion 和输出目录，并显示运行时检测状态。`outputFormat` 只决定导出
下拉框的默认值；任务内部始终先生成 BVH 供预览。`pythonPath` 和
`timeoutSeconds` 也可直接改配置文件。路径全部来自 Electron 的
`app.getPath()` 或用户选择，没有硬编码项目路径。

## Python / MediaPipe 运行时

当前固定使用 `mediapipe==0.10.21`。MediaPipe 0.10.31 及之后移除了
`mediapipe.solutions`，所以不能直接升级到最新版。

```bash
python -m pip install -r electron/motion_capture/sidecar/requirements.txt
```

Windows 安装位置示例：

```text
C:\Users\<user>\AppData\Local\Programs\Python\Python312\python.exe
```

安装后在设置页选择该 `python.exe`，点「检测」。也可以直接运行：

```bash
python electron/motion_capture/sidecar/mocap_sidecar.py --check
```

运行时检测返回 JSON：

```json
{
  "type": "runtime",
  "ok": true,
  "pythonVersion": "3.12.10",
  "mediapipeVersion": "0.10.21",
  "opencvVersion": "4.11.0",
  "legacySolutions": true
}
```

Python 运行时不在安装包内，也不在 Electron 进程内。正式分发前如果要求“装完即用”，
需要另外实现 Python 运行时下载或打包。

## Sidecar 协议

```bash
python mocap_sidecar.py \
  --input sample.mp4 \
  --output out.bvh \
  --fps 30 \
  --format bvh \
  --device cpu \
  --keep-root-motion 0
```

stdout 一行一个 JSON：

```json
{"type":"progress","stage":"pose3d","percent":68,"message":"生成三维骨架"}
{"type":"result","outputPath":"...","previewPath":"...","duration":5,"skeletonId":"humanoid-24","hasRootMotion":false,"warnings":[]}
{"type":"error","code":"NO_PERSON_DETECTED","message":"..."}
```

- stderr 写入任务日志。
- 取消或超时会结束子进程。
- 进程崩溃、找不到解释器、依赖缺失、协议错误都只让当前任务失败，主程序继续运行。
- 任务日志：`%APPDATA%\Nyxel\motion-capture\logs\<jobId>.log`

错误码：

```text
INPUT_NOT_FOUND
SIDECAR_NOT_FOUND
SIDECAR_CRASHED
SIDECAR_PROTOCOL
SIDECAR_DEPS_MISSING
MODEL_NOT_FOUND
NO_PERSON_DETECTED
TIMEOUT
CANCELLED
UNSUPPORTED_FORMAT
EXPORT_FAILED
INTERNAL_ERROR
```

## FBX 导出

- 使用 `@comfyorg/fbx-exporter-three`（MIT，唯一新增运行依赖，内部复用已有的 `fflate`）。
- 从缓存的预览动画创建 `THREE.Bone` 和 `AnimationClip`，导出二进制 FBX 7400。
- `preset: 'unreal'` 写入 `UpAxis=Z`、`FrontAxis=X`，供 UE 使用。
- `preset: 'threejs'` 保持 Y-up，适合 Blender / Three.js / 其他工具。
- `profile: 'ue5'` 会把 24 关节动画重定向为 25 个 UE5 核心骨骼：
  `root, pelvis, spine_01..spine_05, neck_01, head, clavicle_l/r, upperarm_l/r,
  lowerarm_l/r, hand_l/r, thigh_l/r, calf_l/r, foot_l/r, ball_l/r`。
  官方 Manny / Quinn 的详细重定向步骤见 [UE5-RETARGET.md](UE5-RETARGET.md)。
- 只包含骨骼和动画曲线，不包含角色网格或蒙皮权重；UE 中导入后需要把动画绑定到角色骨骼。

## MediaPipe 推理流程

1. OpenCV 读取视频、视频帧率和帧数。
2. MediaPipe Pose 逐帧输出 33 个 world landmarks（米，髋部原点）。
3. 将关键点映射到 24 关节目标位置；对肩、髋、脊柱中心做辅助点构造。
4. 根据静止骨架的骨骼方向，用四元数逐级求解局部旋转。
5. 对输出帧做 3 帧四元数平滑。
6. 写出 BVH 和 `<output>.preview.json`；前端用 Three.js 播放预览。

当前没有使用 SMPL / SMPL-X、人体网格或模型权重下载。MediaPipe 的 Pose 模型
随 `mediapipe==0.10.21` wheel 一起安装。

## 替换为其他模型

后续只需要改 `sidecar/mocap_sidecar.py` 中的推理部分：

1. 保留 CLI 参数和 stdout JSON 协议。
2. 用新的视频解码 / 检测 / 跟踪 / 2D / 3D 推理替换 MediaPipe。
3. 输出同样的 24 关节四元数/BVH，或直接写 BVH 与 preview JSON。
4. 不要在 Electron 主进程导入 torch / onnxruntime。
5. 模型权重和授权由 `modelDir` 指向，不随安装包分发；不要接入未确认商用授权的
   SMPL / SMPL-X 权重。

UI、IPC、配置和 Provider 契约不需要改动。

## 测试与验证

```bash
npm run build:electron
npm run test:motion
```

真实 MediaPipe 集成测试需要本机 Python 和一段视频：

```bash
$env:NYXEL_PYTHON="C:\...\python.exe"
$env:NYXEL_MOTION_REAL_VIDEO="C:\...\sample.mp4"
npm run test:motion:real
```

单元测试覆盖 Mock 全流程、阶段顺序、BVH 结构、Three.js BVHLoader 解析、FBX
导出与 FBXLoader 解析、UE5 25 骨骼重定向导出、取消、超时、Sidecar 崩溃 / 被外部
结束 / 找不到解释器、Sidecar 预览解析。真实测试覆盖 MediaPipe 推理、24 关节
BVH、preview JSON、UE FBX 和 UE5 Mannequin 兼容 FBX 导出。

## 本轮限制

- FBX 只包含骨骼与动画曲线，不包含网格、蒙皮或材质；UE 导入后需绑定角色。
- 本机没有安装 Unreal Engine，UE5 兼容骨架只通过 FBXLoader 做了结构验证，
  没有在 UE 编辑器内实际导入验证。
- MediaPipe 当前只使用 CPU；`device` 的 CUDA / MPS 暂未启用。
- MediaPipe world landmarks 以髋部为原点，本版不估算全局 root motion，
  结果中 `hasRootMotion=false`。视频仍可输出原地骨骼动画。
- 没有引入 SMPL / SMPL-X 权重、人体网格或新的 Electron 运行时依赖。
- Python 运行时和 MediaPipe 依赖需单独安装，未随安装包分发。
- MediaPipe 为 Google 的 Apache-2.0 项目；正式公开分发前请复核 MediaPipe 及其
  随包模型的上游许可和再分发要求。
