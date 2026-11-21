import fs from 'node:fs';
import path from 'node:path';
import type { Quaternion, SkeletonAnimation, SkeletonJoint, Vec3 } from './contracts';

interface EulerZxy {
  x: number;
  y: number;
  z: number;
}

function quatMatrix(q: Quaternion): number[] {
  const [x, y, z, w] = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)
  ];
}

/**
 * BVH uses Zrotation Xrotation Yrotation. The matching local matrix is
 * Rz * Rx * Ry.
 */
export function quaternionToBvhEuler(q: Quaternion): EulerZxy {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const normalized: Quaternion = [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
  const m = quatMatrix(normalized);
  const sinX = Math.max(-1, Math.min(1, m[7]));
  const x = Math.asin(sinX);
  let y: number;
  let z: number;
  if (Math.abs(sinX) > 0.99999) {
    y = Math.atan2(m[2], m[0]);
    z = 0;
  } else {
    y = Math.atan2(-m[6], m[8]);
    z = Math.atan2(-m[1], m[4]);
  }
  return {
    x: (x * 180) / Math.PI,
    y: (y * 180) / Math.PI,
    z: (z * 180) / Math.PI
  };
}

function formatNumber(value: number): string {
  const fixed = Math.abs(value) < 0.0000001 ? 0 : value;
  return fixed.toFixed(4).replace(/\.?0+$/, '') || '0';
}

function formatVec(values: Vec3): string {
  return values.map(formatNumber).join(' ');
}

function writeJoint(
  lines: string[],
  joints: readonly SkeletonJoint[],
  children: number[][],
  index: number,
  depth: number
): void {
  const joint = joints[index];
  const indent = '\t'.repeat(depth);
  lines.push(`${indent}${joint.parent < 0 ? 'ROOT' : 'JOINT'} ${joint.name}`);
  lines.push(`${indent}{`);
  lines.push(`${indent}\tOFFSET ${formatVec(joint.offset)}`);
  if (joint.parent < 0) {
    lines.push(`${indent}\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`);
  } else {
    lines.push(`${indent}\tCHANNELS 3 Zrotation Xrotation Yrotation`);
  }

  const kids = children[index];
  if (kids.length === 0) {
    lines.push(`${indent}\tEnd Site`);
    lines.push(`${indent}\t{`);
    lines.push(`${indent}\t\tOFFSET 0 0 0`);
    lines.push(`${indent}\t}`);
  } else {
    for (const child of kids) writeJoint(lines, joints, children, child, depth + 1);
  }
  lines.push(`${indent}}`);
}

export function writeBvh(animation: SkeletonAnimation, outputPath: string, keepRootMotion: boolean): void {
  const joints = animation.joints;
  const children: number[][] = joints.map(() => []);
  for (let index = 0; index < joints.length; index += 1) {
    const parent = joints[index].parent;
    if (parent >= 0 && parent < joints.length) children[parent].push(index);
  }

  const lines: string[] = ['HIERARCHY'];
  const root = joints.findIndex((joint) => joint.parent < 0);
  if (root < 0) throw new Error('BVH 骨架缺少根关节');
  writeJoint(lines, joints, children, root, 0);
  lines.push('MOTION');
  lines.push(`Frames: ${animation.frames.length}`);
  lines.push(`Frame Time: ${formatNumber(1 / animation.fps)}`);

  for (const frame of animation.frames) {
    const values: string[] = [];
    for (let index = 0; index < joints.length; index += 1) {
      const pose = frame.poses[index];
      const rotation = quaternionToBvhEuler(pose.rotation);
      if (index === root) {
        const translation = keepRootMotion ? pose.translation : ([0, 0, 0] as Vec3);
        values.push(formatVec(translation));
      }
      values.push(formatNumber(rotation.z), formatNumber(rotation.x), formatNumber(rotation.y));
    }
    lines.push(values.join(' '));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}
