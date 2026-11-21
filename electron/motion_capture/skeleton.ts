import {
  HUMANOID_JOINT_COUNT,
  HUMANOID_JOINTS,
  SKELETON_ID,
  type JointPose,
  type Quaternion,
  type SkeletonAnimation,
  type SkeletonFrame
} from './contracts';

export const IDENTITY_QUATERNION: Quaternion = [0, 0, 0, 1];

export function quatAxisAngle(axis: 'x' | 'y' | 'z', radians: number): Quaternion {
  const half = radians / 2;
  const sin = Math.sin(half);
  if (axis === 'x') return [sin, 0, 0, Math.cos(half)];
  if (axis === 'y') return [0, sin, 0, Math.cos(half)];
  return [0, 0, sin, Math.cos(half)];
}

export function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

export function quatFromEuler(x: number, y: number, z: number): Quaternion {
  return quatMultiply(quatMultiply(quatAxisAngle('z', z), quatAxisAngle('x', x)), quatAxisAngle('y', y));
}

function pose(rotation: Quaternion = IDENTITY_QUATERNION, translation: [number, number, number] = [0, 0, 0]): JointPose {
  return { rotation, translation };
}

/**
 * Deterministic sample walk used by the Mock backend. It intentionally does
 * not inspect the input video; the next round replaces this with real pose
 * inference while keeping the same provider contract.
 */
export function createMockAnimation(fps: number, keepRootMotion: boolean, duration = 5): SkeletonAnimation {
  const safeFps = Math.max(1, Math.min(120, Math.round(fps) || 30));
  const frameCount = Math.max(2, Math.round(duration * safeFps) + 1);
  const frames: SkeletonFrame[] = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / safeFps;
    const cycle = time * Math.PI * 2 * 0.9;
    const stride = Math.sin(cycle);
    const opposite = Math.sin(cycle + Math.PI);
    const bob = Math.sin(cycle * 2);
    const breath = Math.sin(cycle * 0.5);

    const poses: JointPose[] = Array.from({ length: HUMANOID_JOINT_COUNT }, () => pose());
    poses[0] = pose(IDENTITY_QUATERNION, keepRootMotion
      ? [0.018 * Math.sin(cycle * 0.5), 0.012 * bob, 0.025 * (time / duration)]
      : [0, 0, 0]);

    poses[1] = pose(quatFromEuler(0.035 * bob, 0.04 * breath, 0));
    poses[2] = pose(quatFromEuler(-0.025 * bob, 0.035 * breath, 0.02 * stride));
    poses[3] = pose(quatFromEuler(0.015 * bob, -0.04 * breath, -0.025 * stride));
    poses[4] = pose(quatFromEuler(-0.02 * breath, 0.05 * Math.sin(cycle * 0.35), 0));
    poses[5] = pose(quatFromEuler(0.03 * breath, 0.08 * Math.sin(cycle * 0.35), 0.025 * stride));

    poses[6] = pose(quatFromEuler(0.04 * opposite, 0, 0.05));
    poses[7] = pose(quatFromEuler(0.06 * opposite, 0, 0.04));
    poses[8] = pose(quatFromEuler(-0.42 * stride, 0.04, 0.05));
    poses[9] = pose(quatFromEuler(0.12 + Math.max(0, -stride) * 0.35, 0, 0));
    poses[10] = pose(quatFromEuler(0.05 * stride, 0, 0));

    poses[11] = pose(quatFromEuler(0.04 * stride, 0, -0.05));
    poses[12] = pose(quatFromEuler(0.06 * stride, 0, -0.04));
    poses[13] = pose(quatFromEuler(0.42 * stride, -0.04, -0.05));
    poses[14] = pose(quatFromEuler(0.12 + Math.max(0, stride) * 0.35, 0, 0));
    poses[15] = pose(quatFromEuler(-0.05 * stride, 0, 0));

    poses[16] = pose(quatFromEuler(0.5 * stride, 0, 0));
    poses[17] = pose(quatFromEuler(-Math.max(0, -stride) * 0.65, 0, 0));
    poses[18] = pose(quatFromEuler(0.16 * stride, 0, 0));
    poses[19] = pose(quatFromEuler(-0.18 * Math.max(0, stride), 0, 0));

    poses[20] = pose(quatFromEuler(-0.5 * stride, 0, 0));
    poses[21] = pose(quatFromEuler(-Math.max(0, stride) * 0.65, 0, 0));
    poses[22] = pose(quatFromEuler(-0.16 * stride, 0, 0));
    poses[23] = pose(quatFromEuler(0.18 * Math.max(0, -stride), 0, 0));

    frames.push({ time, poses });
  }

  return {
    skeletonId: SKELETON_ID,
    fps: safeFps,
    duration: (frameCount - 1) / safeFps,
    joints: HUMANOID_JOINTS.map((joint) => ({
      ...joint,
      offset: [...joint.offset] as [number, number, number]
    })),
    frames,
    hasRootMotion: keepRootMotion
  };
}
