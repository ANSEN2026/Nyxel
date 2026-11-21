import fs from 'node:fs';
import path from 'node:path';
import type { SkeletonAnimation } from './contracts';
import { buildUe5Animation } from './ue5-profile';

export type FbxPreset = 'threejs' | 'unity' | 'unreal' | 'blender' | 'maya';
export type FbxProfile = 'generic' | 'ue5';

type ThreeModule = typeof import('three');
type FbxModule = typeof import('@comfyorg/fbx-exporter-three');

// The Electron main bundle is CommonJS while three and the FBX exporter are
// ESM-only. Keep a native import function so TypeScript does not rewrite this
// into require().
const nativeImport = new Function('specifier', 'return import(specifier)') as
  <T>(specifier: string) => Promise<T>;

let threePromise: Promise<ThreeModule> | null = null;
let fbxPromise: Promise<FbxModule> | null = null;

function loadThree(): Promise<ThreeModule> {
  if (!threePromise) threePromise = nativeImport<ThreeModule>('three');
  return threePromise;
}

function loadFbxModule(): Promise<FbxModule> {
  if (!fbxPromise) fbxPromise = nativeImport<FbxModule>('@comfyorg/fbx-exporter-three');
  return fbxPromise;
}

/**
 * Converts the canonical 24-joint animation into a binary FBX.
 *
 * preset "unreal" writes GlobalSettings.UpAxis = Z (UE), while "threejs"
 * keeps Y-up. The exporter itself handles the axis metadata; we do not mutate
 * the source quaternions.
 */
export async function writeFbx(
  animation: SkeletonAnimation,
  outputPath: string,
  preset: FbxPreset = 'unreal',
  profile: FbxProfile = 'generic'
): Promise<number> {
  const THREE = await loadThree();
  const { FBXExporter } = await loadFbxModule();
  const exportAnimation = profile === 'ue5' ? buildUe5Animation(animation) : animation;

  const scene = new THREE.Scene();
  scene.name = 'MotionCapture';
  const armature = new THREE.Group();
  armature.name = 'Armature';
  scene.add(armature);

  const bones = exportAnimation.joints.map((joint) => {
    const bone = new THREE.Bone();
    bone.name = joint.name;
    bone.position.set(joint.offset[0], joint.offset[1], joint.offset[2]);
    return bone;
  });

  exportAnimation.joints.forEach((joint, index) => {
    if (joint.parent >= 0 && joint.parent < bones.length) {
      bones[joint.parent].add(bones[index]);
    } else {
      armature.add(bones[index]);
    }
  });

  const times = exportAnimation.frames.map((frame) => frame.time);
  const tracks: import('three').KeyframeTrack[] = [];
  exportAnimation.joints.forEach((joint, index) => {
    const positions: number[] = [];
    const rotations: number[] = [];
    for (const frame of exportAnimation.frames) {
      const pose = frame.poses[index];
      positions.push(
        joint.offset[0] + pose.translation[0],
        joint.offset[1] + pose.translation[1],
        joint.offset[2] + pose.translation[2]
      );
      rotations.push(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${joint.name}.position`, times, positions));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${joint.name}.quaternion`, times, rotations));
  });

  const clip = new THREE.AnimationClip('Take001', exportAnimation.duration, tracks);
  (scene as unknown as { animations: import('three').AnimationClip[] }).animations = [clip];

  const exporter = new FBXExporter();
  const bytes = exporter.parseSync(scene, {
    preset,
    fps: exportAnimation.fps,
    animations: [clip],
    includeAnimations: true,
    embedTextures: false
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bytes);
  return bytes.byteLength;
}
