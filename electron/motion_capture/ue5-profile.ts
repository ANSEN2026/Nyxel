import type {
  JointPose,
  Quaternion,
  SkeletonAnimation,
  SkeletonFrame,
  SkeletonJoint,
  Vec3
} from './contracts';

/**
 * UE5 Mannequin core skeleton (no fingers / twist / IK bones).
 * The names and hierarchy match UE5's Manny/Quinn skeleton so the result can
 * be retargeted with UE's IK Retargeter. Epic's actual assets are not bundled.
 */
export const UE5_JOINTS: readonly SkeletonJoint[] = [
  { name: 'root', parent: -1, offset: [0, 0, 0] },
  { name: 'pelvis', parent: 0, offset: [0, 0.95, 0] },
  { name: 'spine_01', parent: 1, offset: [0, 0.12, 0] },
  { name: 'spine_02', parent: 2, offset: [0, 0.08, 0] },
  { name: 'spine_03', parent: 3, offset: [0, 0.1, 0] },
  { name: 'spine_04', parent: 4, offset: [0, 0.08, 0] },
  { name: 'spine_05', parent: 5, offset: [0, 0.06, 0] },
  { name: 'neck_01', parent: 6, offset: [0, 0.12, 0] },
  { name: 'head', parent: 7, offset: [0, 0.12, 0] },
  { name: 'clavicle_l', parent: 6, offset: [0.04, 0.16, 0] },
  { name: 'upperarm_l', parent: 9, offset: [0.12, 0.02, 0] },
  { name: 'lowerarm_l', parent: 10, offset: [0, -0.28, 0] },
  { name: 'hand_l', parent: 11, offset: [0, -0.25, 0] },
  { name: 'clavicle_r', parent: 6, offset: [-0.04, 0.16, 0] },
  { name: 'upperarm_r', parent: 13, offset: [-0.12, 0.02, 0] },
  { name: 'lowerarm_r', parent: 14, offset: [0, -0.28, 0] },
  { name: 'hand_r', parent: 15, offset: [0, -0.25, 0] },
  { name: 'thigh_l', parent: 1, offset: [0.09, -0.06, 0] },
  { name: 'calf_l', parent: 17, offset: [0, -0.42, 0] },
  { name: 'foot_l', parent: 18, offset: [0, -0.4, 0] },
  { name: 'ball_l', parent: 19, offset: [0, -0.02, 0.12] },
  { name: 'thigh_r', parent: 1, offset: [-0.09, -0.06, 0] },
  { name: 'calf_r', parent: 21, offset: [0, -0.42, 0] },
  { name: 'foot_r', parent: 22, offset: [0, -0.4, 0] },
  { name: 'ball_r', parent: 23, offset: [0, -0.02, 0.12] }
];

export const UE5_JOINT_COUNT = UE5_JOINTS.length;

const UE5_INDEX = new Map(UE5_JOINTS.map((joint, index) => [joint.name, index]));

const PRIMARY_CHILD: Record<string, string> = {
  root: 'pelvis',
  pelvis: 'spine_01',
  spine_01: 'spine_02',
  spine_02: 'spine_03',
  spine_03: 'spine_04',
  spine_04: 'spine_05',
  spine_05: 'neck_01',
  neck_01: 'head',
  clavicle_l: 'upperarm_l',
  upperarm_l: 'lowerarm_l',
  lowerarm_l: 'hand_l',
  clavicle_r: 'upperarm_r',
  upperarm_r: 'lowerarm_r',
  lowerarm_r: 'hand_r',
  thigh_l: 'calf_l',
  calf_l: 'foot_l',
  foot_l: 'ball_l',
  thigh_r: 'calf_r',
  calf_r: 'foot_r',
  foot_r: 'ball_r'
};

const IDENTITY: Quaternion = [0, 0, 0, 1];

function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vMul(a: Vec3, value: number): Vec3 {
  return [a[0] * value, a[1] * value, a[2] * value];
}

function vMid(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

function vLerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function vLen(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function vNorm(a: Vec3): Vec3 {
  const length = vLen(a);
  return length < 1e-9 ? [0, 0, 0] : [a[0] / length, a[1] / length, a[2] / length];
}

function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function qMul(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

function qConj(q: Quaternion): Quaternion {
  return [-q[0], -q[1], -q[2], q[3]];
}

function qNorm(q: Quaternion): Quaternion {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return length < 1e-9 ? [...IDENTITY] : [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function qRotate(q: Quaternion, v: Vec3): Vec3 {
  const qv: Quaternion = [v[0], v[1], v[2], 0];
  const result = qMul(qMul(q, qv), qConj(q));
  return [result[0], result[1], result[2]];
}

function qFromTo(from: Vec3, to: Vec3): Quaternion {
  const a = vNorm(from);
  const b = vNorm(to);
  if (vLen(a) < 1e-9 || vLen(b) < 1e-9) return [...IDENTITY];
  const dot = Math.max(-1, Math.min(1, vDot(a, b)));
  if (dot > 0.999999) return [...IDENTITY];
  if (dot < -0.999999) {
    let axis = vCross(a, [1, 0, 0]);
    if (vLen(axis) < 1e-5) axis = vCross(a, [0, 1, 0]);
    axis = vNorm(axis);
    return [axis[0], axis[1], axis[2], 0];
  }
  const axis = vCross(a, b);
  return qNorm([axis[0], axis[1], axis[2], 1 + dot]);
}

interface SourceWorld {
  positions: Vec3[];
  rotations: Quaternion[];
  index: Map<string, number>;
}

function sourceWorld(animation: SkeletonAnimation, frame: SkeletonFrame): SourceWorld {
  const index = new Map(animation.joints.map((joint, jointIndex) => [joint.name, jointIndex]));
  const positions: Vec3[] = new Array(animation.joints.length);
  const rotations: Quaternion[] = new Array(animation.joints.length);

  animation.joints.forEach((joint, jointIndex) => {
    const pose = frame.poses[jointIndex];
    if (joint.parent < 0) {
      positions[jointIndex] = [
        joint.offset[0] + pose.translation[0],
        joint.offset[1] + pose.translation[1],
        joint.offset[2] + pose.translation[2]
      ];
      rotations[jointIndex] = qNorm(pose.rotation);
      return;
    }
    const parentPosition = positions[joint.parent];
    const parentRotation = rotations[joint.parent];
    const localOffset: Vec3 = [
      joint.offset[0] + pose.translation[0],
      joint.offset[1] + pose.translation[1],
      joint.offset[2] + pose.translation[2]
    ];
    positions[jointIndex] = vAdd(parentPosition, qRotate(parentRotation, localOffset));
    rotations[jointIndex] = qNorm(qMul(parentRotation, pose.rotation));
  });

  return { positions, rotations, index };
}

function sourcePosition(world: SourceWorld, name: string): Vec3 {
  const index = world.index.get(name);
  if (index === undefined) throw new Error(`源骨架缺少关节 ${name}`);
  return world.positions[index];
}

function targetPositions(world: SourceWorld): Vec3[] {
  const p = (name: string): Vec3 => sourcePosition(world, name);
  const spine = p('spine');
  const chest = p('chest');
  const neck = p('neck');
  const leftShoulder = p('l_shoulder');
  const rightShoulder = p('r_shoulder');

  return [
    p('root'),
    p('hips'),
    spine,
    vLerp(spine, chest, 0.33),
    chest,
    vLerp(chest, neck, 0.33),
    vLerp(chest, neck, 0.66),
    neck,
    p('head'),
    p('l_clavicle'),
    leftShoulder,
    p('l_forearm'),
    p('l_hand'),
    p('r_clavicle'),
    rightShoulder,
    p('r_forearm'),
    p('r_hand'),
    p('l_upperleg'),
    p('l_lowerleg'),
    p('l_foot'),
    p('l_toe'),
    p('r_upperleg'),
    p('r_lowerleg'),
    p('r_foot'),
    p('r_toe')
  ];
}

function solveTarget(targets: Vec3[]): JointPose[] {
  const local: Quaternion[] = UE5_JOINTS.map(() => [...IDENTITY]);
  const world: Quaternion[] = UE5_JOINTS.map(() => [...IDENTITY]);

  UE5_JOINTS.forEach((joint, jointIndex) => {
    if (joint.parent < 0) {
      local[jointIndex] = [...IDENTITY];
      world[jointIndex] = [...IDENTITY];
      return;
    }
    const parentWorld = world[joint.parent];
    const childName = PRIMARY_CHILD[joint.name];
    if (!childName) {
      local[jointIndex] = [...IDENTITY];
      world[jointIndex] = parentWorld;
      return;
    }
    const childIndex = UE5_INDEX.get(childName);
    if (childIndex === undefined) {
      local[jointIndex] = [...IDENTITY];
      world[jointIndex] = parentWorld;
      return;
    }
    const restDir = UE5_JOINTS[childIndex].offset;
    const desired = vSub(targets[childIndex], targets[jointIndex]);
    if (vLen(restDir) < 1e-7 || vLen(desired) < 1e-7) {
      local[jointIndex] = [...IDENTITY];
      world[jointIndex] = parentWorld;
      return;
    }
    const targetWorld = qFromTo(restDir, desired);
    local[jointIndex] = qNorm(qMul(qConj(parentWorld), targetWorld));
    world[jointIndex] = targetWorld;
  });

  return UE5_JOINTS.map((joint, index) => ({
    rotation: local[index],
    translation: joint.parent < 0 ? targets[index] : [0, 0, 0]
  }));
}

/**
 * Builds a 25-bone UE5 Mannequin-compatible animation from our 24-joint
 * canonical animation. It keeps the original motion and produces UE bone names
 * so it can be imported/retargeted in UE5.
 */
export function buildUe5Animation(animation: SkeletonAnimation): SkeletonAnimation {
  const frames = animation.frames.map((frame) => {
    const world = sourceWorld(animation, frame);
    const targets = targetPositions(world);
    return {
      time: frame.time,
      poses: solveTarget(targets)
    };
  });

  return {
    skeletonId: 'ue5-mannequin-core',
    fps: animation.fps,
    duration: animation.duration,
    joints: UE5_JOINTS.map((joint) => ({
      ...joint,
      offset: [...joint.offset] as Vec3
    })),
    frames,
    hasRootMotion: animation.hasRootMotion
  };
}
