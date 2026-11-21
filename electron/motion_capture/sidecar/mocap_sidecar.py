#!/usr/bin/env python3
"""Real MediaPipe motion-capture sidecar.

The Electron main process only talks to this file over CLI arguments and
line-delimited JSON on stdout. MediaPipe, OpenCV and their dependencies live
inside the Python runtime, never inside the Electron process.

This implementation uses the MediaPipe legacy Pose solution from
mediapipe==0.10.21. It produces a 24-joint skeleton, local quaternion rotations
and a BVH file. No SMPL / SMPL-X weights or mesh models are used.
"""

import argparse
import json
import math
import os
import platform
import sys
import time

SKELETON_ID = "humanoid-24"

# (name, parent index, rest offset in meters)
JOINTS = [
    ("root", -1, (0.0, 0.0, 0.0)),
    ("hips", 0, (0.0, 0.95, 0.0)),
    ("spine", 1, (0.0, 0.12, 0.0)),
    ("chest", 2, (0.0, 0.18, 0.0)),
    ("neck", 3, (0.0, 0.20, 0.0)),
    ("head", 4, (0.0, 0.11, 0.0)),
    ("l_clavicle", 3, (0.04, 0.16, 0.0)),
    ("l_shoulder", 6, (0.08, 0.02, 0.0)),
    ("l_upperarm", 7, (0.04, 0.0, 0.0)),
    ("l_forearm", 8, (0.0, -0.28, 0.0)),
    ("l_hand", 9, (0.0, -0.25, 0.0)),
    ("r_clavicle", 3, (-0.04, 0.16, 0.0)),
    ("r_shoulder", 11, (-0.08, 0.02, 0.0)),
    ("r_upperarm", 12, (-0.04, 0.0, 0.0)),
    ("r_forearm", 13, (0.0, -0.28, 0.0)),
    ("r_hand", 14, (0.0, -0.25, 0.0)),
    ("l_upperleg", 1, (0.09, -0.06, 0.0)),
    ("l_lowerleg", 16, (0.0, -0.42, 0.0)),
    ("l_foot", 17, (0.0, -0.40, 0.0)),
    ("l_toe", 18, (0.0, -0.02, 0.12)),
    ("r_upperleg", 1, (-0.09, -0.06, 0.0)),
    ("r_lowerleg", 20, (0.0, -0.42, 0.0)),
    ("r_foot", 21, (0.0, -0.40, 0.0)),
    ("r_toe", 22, (0.0, -0.02, 0.12)),
]

INDEX = {joint[0]: index for index, joint in enumerate(JOINTS)}

# Each joint aligns its rest direction to this child. Joints without a child
# (head, hands, toes) keep identity local rotation; their position is still
# driven by the parent chain.
PRIMARY_CHILD = {
    "root": "hips",
    "hips": "spine",
    "spine": "chest",
    "chest": "neck",
    "neck": "head",
    "l_clavicle": "l_shoulder",
    "l_shoulder": "l_upperarm",
    "l_upperarm": "l_forearm",
    "r_clavicle": "r_shoulder",
    "r_shoulder": "r_upperarm",
    "r_upperarm": "r_forearm",
    "l_upperleg": "l_lowerleg",
    "l_lowerleg": "l_foot",
    "l_foot": "l_toe",
    "r_upperleg": "r_lowerleg",
    "r_lowerleg": "r_foot",
    "r_foot": "r_toe",
}

STAGES = [
    ("decode", 5, "读取视频信息"),
    ("detect", 10, "检测人体区域"),
    ("track", 20, "跟踪画面中的人体"),
    ("pose2d", 42, "估计二维关节点"),
    ("pose3d", 64, "生成三维骨架"),
    ("cleanup", 86, "清理抖动并补帧"),
    ("export", 94, "写入 BVH 文件"),
]


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def progress(stage, percent, message):
    emit({"type": "progress", "stage": stage, "percent": percent, "message": message})


def fail(code, message):
    emit({"type": "error", "code": code, "message": message})
    print(message, file=sys.stderr, flush=True)
    return 1


def fmt(value):
    if abs(value) < 0.0000001:
        value = 0.0
    text = "%.4f" % value
    text = text.rstrip("0").rstrip(".")
    return text or "0"


# ---------------------------------------------------------------------------
# Small vector / quaternion helpers
# ---------------------------------------------------------------------------

def v_add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def v_sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def v_mul(a, scale):
    return (a[0] * scale, a[1] * scale, a[2] * scale)


def v_mid(a, b):
    return ((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5)


def v_len(a):
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def v_norm(a):
    length = v_len(a)
    if length < 1e-9:
        return (0.0, 0.0, 0.0)
    return (a[0] / length, a[1] / length, a[2] / length)


def v_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def v_cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def q_identity():
    return (0.0, 0.0, 0.0, 1.0)


def q_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def q_conj(q):
    return (-q[0], -q[1], -q[2], q[3])


def q_norm(q):
    length = math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    if length < 1e-9:
        return q_identity()
    return (q[0] / length, q[1] / length, q[2] / length, q[3] / length)


def q_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]


def q_from_to(a, b):
    a = v_norm(a)
    b = v_norm(b)
    if v_len(a) < 1e-9 or v_len(b) < 1e-9:
        return q_identity()
    dot = max(-1.0, min(1.0, v_dot(a, b)))
    if dot > 0.999999:
        return q_identity()
    if dot < -0.999999:
        axis = v_cross(a, (1.0, 0.0, 0.0))
        if v_len(axis) < 1e-5:
            axis = v_cross(a, (0.0, 1.0, 0.0))
        axis = v_norm(axis)
        return (axis[0], axis[1], axis[2], 0.0)
    axis = v_cross(a, b)
    return q_norm((axis[0], axis[1], axis[2], 1.0 + dot))


def q_rotate(q, v):
    qv = (v[0], v[1], v[2], 0.0)
    rotated = q_mul(q_mul(q, qv), q_conj(q))
    return (rotated[0], rotated[1], rotated[2])


def q_matrix(q):
    x, y, z, w = q_norm(q)
    return (
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    )


def q_to_euler_zxy(q):
    m = q_matrix(q)
    sin_x = max(-1.0, min(1.0, m[7]))
    x = math.asin(sin_x)
    if abs(sin_x) > 0.99999:
        y = math.atan2(m[2], m[0])
        z = 0.0
    else:
        y = math.atan2(-m[6], m[8])
        z = math.atan2(-m[1], m[4])
    return (
        math.degrees(z),
        math.degrees(x),
        math.degrees(y),
    )


# ---------------------------------------------------------------------------
# MediaPipe landmarks -> canonical 24 joints
# ---------------------------------------------------------------------------

def landmark_to_yup(landmark):
    # MediaPipe world coordinates: x right, y down, z toward the camera.
    # Internal contract: Y-up, +Z forward (toward the camera).
    return (float(landmark.x), -float(landmark.y), -float(landmark.z))


def mediapipe_targets(world_landmarks):
    p = lambda index: landmark_to_yup(world_landmarks.landmark[index])

    left_hip = p(23)
    right_hip = p(24)
    hip_mid = v_mid(left_hip, right_hip)

    left_shoulder = p(11)
    right_shoulder = p(12)
    shoulder_mid = v_mid(left_shoulder, right_shoulder)
    ear_mid = v_mid(p(7), p(8))

    spine = v_add(hip_mid, v_mul(v_sub(shoulder_mid, hip_mid), 0.35))
    chest = v_add(hip_mid, v_mul(v_sub(shoulder_mid, hip_mid), 0.75))
    neck = v_add(shoulder_mid, v_mul(v_sub(ear_mid, shoulder_mid), 0.35))
    head = ear_mid

    # Small offset along the upper arm keeps shoulder and upper-arm joints
    # distinct; otherwise both would sit at the same MediaPipe shoulder point.
    left_upperarm = v_add(left_shoulder, v_mul(v_sub(p(13), left_shoulder), 0.12))
    right_upperarm = v_add(right_shoulder, v_mul(v_sub(p(14), right_shoulder), 0.12))

    targets = [None] * len(JOINTS)
    targets[0] = (0.0, 0.0, 0.0)       # root
    targets[1] = hip_mid               # hips
    targets[2] = spine
    targets[3] = chest
    targets[4] = neck
    targets[5] = head
    targets[6] = v_mid(chest, left_shoulder)    # l_clavicle
    targets[7] = left_shoulder                 # l_shoulder
    targets[8] = left_upperarm                 # l_upperarm
    targets[9] = p(13)                         # l_forearm (elbow)
    targets[10] = p(15)                        # l_hand (wrist)
    targets[11] = v_mid(chest, right_shoulder) # r_clavicle
    targets[12] = right_shoulder
    targets[13] = right_upperarm
    targets[14] = p(14)                        # r_forearm
    targets[15] = p(16)                        # r_hand
    targets[16] = p(23)                        # l_upperleg
    targets[17] = p(25)                        # l_lowerleg (knee)
    targets[18] = p(27)                        # l_foot (ankle)
    targets[19] = p(31)                        # l_toe (foot index)
    targets[20] = p(24)                        # r_upperleg
    targets[21] = p(26)                        # r_lowerleg
    targets[22] = p(28)                        # r_foot
    targets[23] = p(32)                        # r_toe
    return targets


def solve_rotations(targets):
    local = [q_identity() for _ in JOINTS]
    world = [q_identity() for _ in JOINTS]

    for index, (name, parent, _offset) in enumerate(JOINTS):
        if parent < 0:
            local[index] = q_identity()
            world[index] = q_identity()
            continue
        parent_world = world[parent]
        child_name = PRIMARY_CHILD.get(name)
        if not child_name:
            local[index] = q_identity()
            world[index] = parent_world
            continue

        child = INDEX[child_name]
        rest_dir = JOINTS[child][2]
        desired = v_sub(targets[child], targets[index])
        if v_len(desired) < 1e-7 or v_len(rest_dir) < 1e-7:
            local[index] = q_identity()
            world[index] = parent_world
            continue

        target_world = q_from_to(rest_dir, desired)
        local[index] = q_norm(q_mul(q_conj(parent_world), target_world))
        world[index] = q_norm(target_world)

    return local


def smooth_frames(frames):
    if len(frames) < 3:
        return frames
    result = [frames[0]]
    for index in range(1, len(frames) - 1):
        smoothed = []
        for joint in range(len(JOINTS)):
            center = frames[index][joint]
            values = (frames[index - 1][joint], center, frames[index + 1][joint])
            total = [0.0, 0.0, 0.0, 0.0]
            for value in values:
                sign = -1.0 if q_dot(value, center) < 0 else 1.0
                total[0] += value[0] * sign
                total[1] += value[1] * sign
                total[2] += value[2] * sign
                total[3] += value[3] * sign
            smoothed.append(q_norm((total[0], total[1], total[2], total[3])))
        result.append(smoothed)
    result.append(frames[-1])
    return result


# ---------------------------------------------------------------------------
# BVH / preview output
# ---------------------------------------------------------------------------

def children_map():
    children = [[] for _ in JOINTS]
    for index, (_name, parent, _offset) in enumerate(JOINTS):
        if parent >= 0:
            children[parent].append(index)
    return children


def write_joint(lines, children, index, depth):
    name, parent, offset = JOINTS[index]
    indent = "\t" * depth
    lines.append("%s%s %s" % (indent, "ROOT" if parent < 0 else "JOINT", name))
    lines.append(indent + "{")
    lines.append("%s\tOFFSET %s %s %s" % (indent, fmt(offset[0]), fmt(offset[1]), fmt(offset[2])))
    if parent < 0:
        lines.append(indent + "\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation")
    else:
        lines.append(indent + "\tCHANNELS 3 Zrotation Xrotation Yrotation")

    if children[index]:
        for child in children[index]:
            write_joint(lines, children, child, depth + 1)
    else:
        lines.append(indent + "\tEnd Site")
        lines.append(indent + "\t{")
        lines.append(indent + "\t\tOFFSET 0 0 0")
        lines.append(indent + "\t}")
    lines.append(indent + "}")


def write_bvh(output_path, frames, fps):
    children = children_map()
    lines = ["HIERARCHY"]
    write_joint(lines, children, 0, 0)
    lines.append("MOTION")
    lines.append("Frames: %d" % len(frames))
    lines.append("Frame Time: %s" % fmt(1.0 / fps))

    for frame in frames:
        values = []
        for index in range(len(JOINTS)):
            if index == 0:
                # MediaPipe world landmarks are hip-centered; this version does
                # not estimate global root translation.
                values.extend(["0", "0", "0"])
            rotation = q_to_euler_zxy(frame[index])
            values.extend([fmt(rotation[0]), fmt(rotation[1]), fmt(rotation[2])])
        lines.append(" ".join(values))

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines) + "\n")


def write_preview(output_path, frames, fps, duration):
    preview_path = os.path.splitext(output_path)[0] + ".preview.json"
    payload = {
        "skeletonId": SKELETON_ID,
        "fps": fps,
        "duration": duration,
        "joints": [
            {"name": name, "parent": parent, "offset": list(offset)}
            for name, parent, offset in JOINTS
        ],
        "frames": [
            {
                "time": index / float(fps),
                "poses": [
                    {"rotation": list(rotation), "translation": [0.0, 0.0, 0.0]}
                    for rotation in frame
                ],
            }
            for index, frame in enumerate(frames)
        ],
        "hasRootMotion": False,
    }
    with open(preview_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    return preview_path


# ---------------------------------------------------------------------------
# Runtime / video pipeline
# ---------------------------------------------------------------------------

def load_runtime():
    status = {
        "ok": True,
        "pythonVersion": platform.python_version(),
        "pythonPath": sys.executable,
        "missing": [],
        "message": "",
        "mediapipeVersion": "",
        "opencvVersion": "",
        "legacySolutions": False,
    }
    cv2_module = None
    mp_module = None
    try:
        import cv2 as cv2_module  # noqa: F401
        status["opencvVersion"] = getattr(cv2_module, "__version__", "")
    except Exception as error:  # noqa: BLE001
        status["ok"] = False
        status["missing"].append("opencv")
        status["message"] = "缺少 opencv：%s" % error

    try:
        import mediapipe as mp_module
        status["mediapipeVersion"] = getattr(mp_module, "__version__", "")
        status["legacySolutions"] = hasattr(mp_module, "solutions")
        if not status["legacySolutions"]:
            status["ok"] = False
            status["missing"].append("mediapipe.solutions")
            status["message"] = "当前 MediaPipe 版本已移除 solutions，请安装 mediapipe==0.10.21"
    except Exception as error:  # noqa: BLE001
        status["ok"] = False
        status["missing"].append("mediapipe")
        status["message"] = "缺少 mediapipe：%s" % error

    if not status["ok"] and not status["message"]:
        status["message"] = "MediaPipe 运行时未就绪"
    return status, cv2_module, mp_module


def runtime_command():
    status, _cv2, _mp = load_runtime()
    status["type"] = "runtime"
    status["provider"] = "sidecar"
    status["model"] = "mediapipe-pose-legacy"
    emit(status)
    return 0


def resample(frames, times, target_fps, duration):
    if not frames:
        return []
    count = max(2, int(round(duration * target_fps)) + 1)
    output = []
    cursor = 0
    for index in range(count):
        target_time = index / float(target_fps)
        while cursor + 1 < len(times) and times[cursor + 1] <= target_time:
            cursor += 1
        if cursor + 1 < len(times):
            before = abs(target_time - times[cursor])
            after = abs(times[cursor + 1] - target_time)
            frame = frames[cursor if before <= after else cursor + 1]
        else:
            frame = frames[cursor]
        output.append(frame)
    return output


def process_video(args, cv2, mp):
    capture = cv2.VideoCapture(args.input)
    if not capture.isOpened():
        return fail("INPUT_NOT_FOUND", "无法打开视频：%s" % args.input)

    video_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    if video_fps <= 0 or video_fps > 240:
        video_fps = 30.0
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    target_fps = max(1, min(120, int(args.fps or 30)))
    step = max(1, int(round(video_fps / target_fps)))

    progress("decode", 6, "读取视频信息")
    progress("detect", 12, "检测人体区域")

    frames = []
    times = []
    last_pose = None
    detected = 0
    last_percent = 12
    frame_index = 0
    pose_solution = None
    try:
        pose_solution = mp.solutions.pose.Pose(
            static_image_mode=False,
            model_complexity=1,
            smooth_landmarks=True,
            enable_segmentation=False,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % step == 0:
                timestamp = frame_index / video_fps
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = pose_solution.process(rgb)
                if result.pose_world_landmarks:
                    targets = mediapipe_targets(result.pose_world_landmarks)
                    last_pose = solve_rotations(targets)
                    detected += 1
                if last_pose is not None:
                    frames.append(last_pose)
                    times.append(timestamp)

                if frame_count > 0:
                    percent = 12 + int(68 * min(1.0, frame_index / float(frame_count)))
                else:
                    percent = min(80, last_percent + 1)
                if percent - last_percent >= 2:
                    last_percent = percent
                    if percent < 45:
                        stage = "track"
                    elif percent < 65:
                        stage = "pose2d"
                    else:
                        stage = "pose3d"
                    progress(stage, percent, "处理第 %d 帧" % (frame_index + 1))
            frame_index += 1
    finally:
        if pose_solution is not None:
            pose_solution.close()
        capture.release()

    if detected == 0 or not frames:
        return fail("NO_PERSON_DETECTED", "视频中没有检测到完整人体，请换用全身清晰、光线充足的视频")

    if frame_count > 0:
        duration = frame_count / video_fps
    else:
        duration = times[-1] + (1.0 / video_fps)

    progress("cleanup", 88, "清理抖动并补帧")
    sampled = resample(frames, times, target_fps, duration)
    smoothed = smooth_frames(sampled)
    duration = (len(smoothed) - 1) / float(target_fps)

    warnings = []
    if detected < len(frames):
        warnings.append("部分帧未检测到人体，已使用上一帧姿态补齐")
    if args.device != "cpu":
        warnings.append("MediaPipe 当前使用 CPU，设备参数 %s 暂未启用" % args.device)
    if str(args.keep_root_motion).lower() not in ("0", "false", "no"):
        warnings.append("MediaPipe 世界坐标以髋部为原点，本版不包含 root motion")

    progress("export", 94, "写入 BVH 文件")
    write_bvh(args.output, smoothed, target_fps)
    preview_path = write_preview(args.output, smoothed, target_fps, duration)
    emit({
        "type": "result",
        "outputPath": os.path.abspath(args.output),
        "previewPath": os.path.abspath(preview_path),
        "duration": duration,
        "skeletonId": SKELETON_ID,
        "hasRootMotion": False,
        "warnings": warnings,
        "detectedFrames": detected,
        "sampledFrames": len(frames),
        "outputFrames": len(smoothed),
    })
    progress("export", 100, "分析完成")
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--input", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--format", default="bvh")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--keep-root-motion", default="1")
    args = parser.parse_args()

    if args.check:
        return runtime_command()

    status, cv2, mp = load_runtime()
    if not status["ok"]:
        return fail("SIDECAR_DEPS_MISSING", status["message"] or "MediaPipe 运行时未就绪")
    if not args.input or not os.path.isfile(args.input):
        return fail("INPUT_NOT_FOUND", "找不到输入视频")
    if not args.output:
        return fail("SIDECAR_PROTOCOL", "缺少输出路径")
    if args.format != "bvh":
        return fail("UNSUPPORTED_FORMAT", "当前 Sidecar 只支持 BVH")

    started = time.time()
    try:
        result = process_video(args, cv2, mp)
        print("sidecar elapsed %.2fs" % (time.time() - started), file=sys.stderr, flush=True)
        return result
    except Exception as error:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return fail("SIDECAR_CRASHED", "MediaPipe 推理失败：%s" % error)


if __name__ == "__main__":
    sys.exit(main())
