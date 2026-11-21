import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const require = createRequire(import.meta.url);
const { SidecarProvider } = require('../dist-electron/motion_capture/sidecar-provider.js');
const { SKELETON_ID } = require('../dist-electron/motion_capture/contracts.js');
const { writeFbx } = require('../dist-electron/motion_capture/fbx-export.js');

const python = process.env.NYXEL_PYTHON || '';
const video = process.env.NYXEL_MOTION_REAL_VIDEO || '';
const skipReason = !python || !video
  ? 'set NYXEL_PYTHON and NYXEL_MOTION_REAL_VIDEO to run the real MediaPipe test'
  : !fs.existsSync(python)
    ? `Python not found: ${python}`
    : !fs.existsSync(video)
      ? `video not found: ${video}`
      : false;

test('real MediaPipe sidecar produces BVH and preview from a video', { skip: skipReason }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-motion-real-'));
  const config = {
    version: 1,
    provider: 'sidecar',
    modelDir: '',
    device: 'cpu',
    outputFormat: 'bvh',
    fps: 30,
    keepRootMotion: false,
    outputDir: path.join(dir, 'out'),
    pythonPath: python,
    timeoutSeconds: 300
  };
  const job = {
    jobId: 'real-mediapipe',
    inputPath: video,
    fps: 30,
    targetRig: SKELETON_ID,
    createdAt: new Date().toISOString()
  };
  const options = {
    format: 'bvh',
    outputDir: config.outputDir,
    keepRootMotion: false,
    device: 'cpu',
    modelDir: '',
    timeoutMs: 300000,
    logPath: path.join(dir, 'real.log')
  };
  const progress = [];
  const provider = new SidecarProvider(config);
  const result = await provider.run(job, options, {
    onProgress: (event) => progress.push(event),
    log: () => undefined,
    isCancelled: () => false
  });

  assert.equal(result.format, 'bvh');
  assert.equal(result.skeletonId, SKELETON_ID);
  assert.equal(result.hasRootMotion, false);
  assert.ok(result.duration > 0);
  assert.ok(fs.existsSync(result.outputPath));
  assert.ok(progress.some((event) => event.stage === 'pose3d'));
  assert.ok(progress.some((event) => event.stage === 'export' && event.percent === 100));

  const parsed = new BVHLoader().parse(fs.readFileSync(result.outputPath, 'utf8'));
  const knownNames = new Set([
    'root', 'hips', 'spine', 'chest', 'neck', 'head',
    'l_clavicle', 'l_shoulder', 'l_upperarm', 'l_forearm', 'l_hand',
    'r_clavicle', 'r_shoulder', 'r_upperarm', 'r_forearm', 'r_hand',
    'l_upperleg', 'l_lowerleg', 'l_foot', 'l_toe',
    'r_upperleg', 'r_lowerleg', 'r_foot', 'r_toe'
  ]);
  const names = new Set(parsed.skeleton.bones.map((bone) => bone.name).filter((name) => knownNames.has(name)));
  assert.equal(names.size, 24);
  assert.ok(parsed.clip.duration > 0);

  const preview = await provider.getPreview(job.jobId);
  assert.ok(preview);
  assert.equal(preview.joints.length, 24);
  assert.ok(preview.frames.length > 2);
  assert.equal(preview.hasRootMotion, false);

  const fbxPath = path.join(dir, 'real-ue.fbx');
  await writeFbx(preview, fbxPath, 'unreal');
  const fbxRaw = fs.readFileSync(fbxPath);
  assert.equal(fbxRaw.subarray(0, 18).toString('binary'), 'Kaydara FBX Binary');
  const fbx = new FBXLoader().parse(
    fbxRaw.buffer.slice(fbxRaw.byteOffset, fbxRaw.byteOffset + fbxRaw.byteLength),
    ''
  );
  let boneCount = 0;
  fbx.traverse((node) => {
    if (node.isBone) boneCount += 1;
  });
  assert.equal(boneCount, 24);
  assert.equal(fbx.animations.length, 1);

  const ue5Path = path.join(dir, 'real-ue5.fbx');
  await writeFbx(preview, ue5Path, 'unreal', 'ue5');
  const ue5Raw = fs.readFileSync(ue5Path);
  assert.equal(ue5Raw.subarray(0, 18).toString('binary'), 'Kaydara FBX Binary');
  const ue5 = new FBXLoader().parse(
    ue5Raw.buffer.slice(ue5Raw.byteOffset, ue5Raw.byteOffset + ue5Raw.byteLength),
    ''
  );
  let ue5Bones = 0;
  const ue5Names = new Set();
  ue5.traverse((node) => {
    if (node.isBone) {
      ue5Bones += 1;
      ue5Names.add(node.name);
    }
  });
  assert.equal(ue5Bones, 25);
  assert.ok(ue5Names.has('pelvis'));
  assert.ok(ue5Names.has('upperarm_l'));
  assert.ok(ue5Names.has('ball_r'));
});
