import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Euler, Quaternion } from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const require = createRequire(import.meta.url);
const { MockProvider } = require('../dist-electron/motion_capture/mock-provider.js');
const { SidecarProvider } = require('../dist-electron/motion_capture/sidecar-provider.js');
const { HUMANOID_JOINTS, MOTION_STAGES, SKELETON_ID } = require('../dist-electron/motion_capture/contracts.js');
const { quaternionToBvhEuler } = require('../dist-electron/motion_capture/bvh.js');
const { writeFbx } = require('../dist-electron/motion_capture/fbx-export.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-motion-'));
}

function loadServiceWithElectron(root) {
  const NodeModule = require('node:module');
  const originalLoad = NodeModule._load;
  const servicePath = require.resolve('../dist-electron/motion_capture/service.js');
  delete require.cache[servicePath];
  let MotionCaptureService;
  try {
    NodeModule._load = function (request, parent, isMain) {
      if (request === 'electron') {
        return {
          app: { getPath: () => root },
          dialog: { showSaveDialog: async () => ({ canceled: true }) }
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    ({ MotionCaptureService } = require(servicePath));
  } finally {
    NodeModule._load = originalLoad;
  }
  return MotionCaptureService;
}

function makeInput(dir) {
  const file = path.join(dir, 'sample.mp4');
  fs.writeFileSync(file, 'fake video bytes');
  return file;
}

function makeJob(input, jobId = 'test-job') {
  return {
    jobId,
    inputPath: input,
    fps: 30,
    targetRig: SKELETON_ID,
    createdAt: new Date().toISOString()
  };
}

function makeOptions(dir) {
  return {
    format: 'bvh',
    outputDir: path.join(dir, 'out'),
    keepRootMotion: true,
    device: 'cpu',
    modelDir: '',
    timeoutMs: 5000,
    logPath: path.join(dir, 'job.log')
  };
}

function makeContext(progress, logs = []) {
  return {
    onProgress: (event) => progress.push(event),
    log: (message) => logs.push(message),
    isCancelled: () => false
  };
}

function parseBvh(file) {
  const text = fs.readFileSync(file, 'utf8');
  const motionIndex = text.indexOf('MOTION');
  assert.ok(motionIndex > 0, 'BVH should contain MOTION');
  const hierarchy = text.slice(0, motionIndex);
  const motion = text.slice(motionIndex).split(/\r?\n/).filter(Boolean);
  const framesLine = motion.find((line) => line.startsWith('Frames:'));
  const frameTimeLine = motion.find((line) => line.startsWith('Frame Time:'));
  const frameCount = Number(framesLine.split(':')[1].trim());
  const motionLines = motion.slice(motion.indexOf(frameTimeLine) + 1);
  const rootCount = (hierarchy.match(/^ROOT\s+/gm) || []).length;
  const jointCount = (hierarchy.match(/^\s*JOINT\s+/gm) || []).length + rootCount;
  return {
    text,
    hierarchy,
    frameCount,
    frameTime: Number(frameTimeLine.split(':')[1].trim()),
    motionLines,
    jointCount
  };
}

function writeStub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const STUB_HEADER = `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
const output = arg('--output');
`;

function sidecarConfig(dir, pythonPath) {
  return {
    version: 1,
    provider: 'sidecar',
    modelDir: '',
    device: 'cpu',
    outputFormat: 'bvh',
    fps: 30,
    keepRootMotion: true,
    outputDir: path.join(dir, 'out'),
    pythonPath,
    timeoutSeconds: 10
  };
}

test('BVH ZXY euler conversion round-trips a quaternion', () => {
  const source = new Euler(0.31, -0.42, 0.57, 'ZXY');
  const quaternion = new Quaternion().setFromEuler(source);
  const converted = quaternionToBvhEuler([quaternion.x, quaternion.y, quaternion.z, quaternion.w]);
  const toDegrees = (value) => (value * 180) / Math.PI;
  assert.ok(Math.abs(converted.x - toDegrees(source.x)) < 0.001);
  assert.ok(Math.abs(converted.y - toDegrees(source.y)) < 0.001);
  assert.ok(Math.abs(converted.z - toDegrees(source.z)) < 0.001);
});

test('mock provider runs the full flow and writes a valid 24-joint BVH', async () => {
  const dir = tempDir();
  const input = makeInput(dir);
  const provider = new MockProvider();
  const progress = [];
  const logs = [];
  const result = await provider.run(makeJob(input), makeOptions(dir), makeContext(progress, logs));

  assert.equal(result.format, 'bvh');
  assert.equal(result.fps, 30);
  assert.equal(result.skeletonId, SKELETON_ID);
  assert.equal(result.hasRootMotion, true);
  assert.ok(result.duration > 0);
  assert.ok(result.outputPath.endsWith('.bvh'));
  assert.ok(fs.existsSync(result.outputPath));
  assert.ok(result.warnings.some((warning) => warning.includes('Mock')));

  const stageSequence = [...new Set(progress.map((event) => event.stage))];
  assert.deepEqual(stageSequence, [...MOTION_STAGES]);
  assert.equal(progress[progress.length - 1].percent, 100);
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok(progress[index].percent >= progress[index - 1].percent, 'progress must not go backwards');
  }

  const bvh = parseBvh(result.outputPath);
  assert.equal(bvh.jointCount, 24);
  assert.equal(bvh.frameCount, 151);
  assert.ok(Math.abs(bvh.frameTime - 1 / 30) < 0.0002);
  assert.equal(bvh.motionLines.length, 151);
  assert.equal(bvh.motionLines[0].trim().split(/\s+/).length, 75);
  for (const joint of HUMANOID_JOINTS) {
    assert.match(bvh.hierarchy, new RegExp(`\\b${joint.name}\\b`), `missing ${joint.name}`);
  }

  const parsed = new BVHLoader().parse(bvh.text);
  const knownNames = new Set(HUMANOID_JOINTS.map((joint) => joint.name));
  const parsedNames = parsed.skeleton.bones.map((bone) => bone.name).filter((name) => knownNames.has(name));
  assert.equal(new Set(parsedNames).size, 24);
  assert.ok(parsed.skeleton.bones.length >= 24);
  assert.ok(parsed.clip.duration > 4.9);

  const preview = await provider.getPreview(result.jobId);
  assert.ok(preview);
  assert.equal(preview.joints.length, 24);
  assert.equal(preview.frames.length, 151);
  assert.ok(logs.length > 0);

  const fbxPath = path.join(dir, 'mock-ue.fbx');
  const fbxBytes = await writeFbx(preview, fbxPath, 'unreal');
  assert.ok(fbxBytes > 1000);
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
  assert.ok(fbx.animations[0].duration > 4.9);

  const yupPath = path.join(dir, 'mock-yup.fbx');
  await writeFbx(preview, yupPath, 'threejs');
  const yupRaw = fs.readFileSync(yupPath);
  assert.equal(yupRaw.subarray(0, 18).toString('binary'), 'Kaydara FBX Binary');
  const yup = new FBXLoader().parse(
    yupRaw.buffer.slice(yupRaw.byteOffset, yupRaw.byteOffset + yupRaw.byteLength),
    ''
  );
  let yupBones = 0;
  yup.traverse((node) => {
    if (node.isBone) yupBones += 1;
  });
  assert.equal(yupBones, 24);

  const ue5Path = path.join(dir, 'mock-ue5.fbx');
  await writeFbx(preview, ue5Path, 'unreal', 'ue5');
  const ue5Raw = fs.readFileSync(ue5Path);
  assert.equal(ue5Raw.subarray(0, 18).toString('binary'), 'Kaydara FBX Binary');
  const ue5 = new FBXLoader().parse(
    ue5Raw.buffer.slice(ue5Raw.byteOffset, ue5Raw.byteOffset + ue5Raw.byteLength),
    ''
  );
  const ue5Names = new Set();
  let ue5Bones = 0;
  ue5.traverse((node) => {
    if (node.isBone) {
      ue5Bones += 1;
      ue5Names.add(node.name);
    }
  });
  assert.equal(ue5Bones, 25);
  for (const name of [
    'pelvis', 'spine_01', 'spine_05', 'neck_01', 'head',
    'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
    'thigh_r', 'calf_r', 'foot_r', 'ball_r'
  ]) {
    assert.ok(ue5Names.has(name), `missing UE5 bone ${name}`);
  }
});

test('mock provider can be cancelled without producing a result', async () => {
  const dir = tempDir();
  const input = makeInput(dir);
  const provider = new MockProvider();
  const progress = [];
  const promise = provider.run(makeJob(input, 'cancel-job'), makeOptions(dir), makeContext(progress));
  const rejection = assert.rejects(promise, (error) => error.code === 'CANCELLED');
  await delay(220);
  await provider.cancel('cancel-job');
  await rejection;
});

test('sidecar provider accepts progress and result JSON from an isolated process', async () => {
  const dir = tempDir();
  const input = makeInput(dir);
  const script = writeStub(dir, 'ok-sidecar.cjs', `${STUB_HEADER}
emit({ type: 'progress', stage: 'decode', percent: 10, message: 'decode' });
emit({ type: 'progress', stage: 'pose3d', percent: 70, message: 'pose' });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, 'HIERARCHY\\nROOT root\\n{\\nOFFSET 0 0 0\\nCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\\nEnd Site\\n{\\nOFFSET 0 0 0\\n}\\n}\\nMOTION\\nFrames: 1\\nFrame Time: 0.0333\\n0 0 0 0 0 0\\n');
const preview = output.replace(/\\.bvh$/i, '.preview.json');
const joints = Array.from({ length: 24 }, (_, index) => ({ name: 'j' + index, parent: index ? index - 1 : -1, offset: [0, 0, 0] }));
const frames = Array.from({ length: 2 }, (_, index) => ({ time: index / 30, poses: joints.map(() => ({ rotation: [0, 0, 0, 1], translation: [0, 0, 0] })) }));
fs.writeFileSync(preview, JSON.stringify({ skeletonId: 'humanoid-24', fps: 30, duration: 1, joints, frames, hasRootMotion: false }));
emit({ type: 'result', outputPath: output, previewPath: preview, duration: 1, skeletonId: 'humanoid-24', hasRootMotion: true, warnings: ['stub'] });
`);
  const provider = new SidecarProvider(sidecarConfig(dir, process.execPath), script);
  const progress = [];
  const result = await provider.run(makeJob(input, 'sidecar-ok'), makeOptions(dir), makeContext(progress));
  assert.equal(result.format, 'bvh');
  assert.equal(result.skeletonId, SKELETON_ID);
  assert.equal(result.duration, 1);
  assert.deepEqual(result.warnings, ['stub']);
  assert.equal(progress.length, 2);
  assert.ok(fs.existsSync(result.outputPath));
  const preview = await provider.getPreview('sidecar-ok');
  assert.ok(preview);
  assert.equal(preview.joints.length, 24);
  assert.equal(preview.frames.length, 2);
});

test('sidecar provider reports a crashed process without taking down the caller', async () => {
  const dir = tempDir();
  const input = makeInput(dir);
  const script = writeStub(dir, 'crash-sidecar.cjs', `${STUB_HEADER}
process.stderr.write('stub crash\\n');
process.exit(2);
`);
  const provider = new SidecarProvider(sidecarConfig(dir, process.execPath), script);
  await assert.rejects(
    provider.run(makeJob(input, 'sidecar-crash'), makeOptions(dir), makeContext([])),
    (error) => error.code === 'SIDECAR_CRASHED' && error.message.includes('stub crash')
  );
});

test('sidecar provider survives a process killed outside the provider', async () => {
  const dir = tempDir();
  const input = makeInput(dir);
  const script = writeStub(dir, 'killed-sidecar.cjs', `${STUB_HEADER}
emit({ type: 'progress', stage: 'decode', percent: 10, message: 'running' });
setTimeout(() => process.kill(process.pid), 120);
`);
  const provider = new SidecarProvider(sidecarConfig(dir, process.execPath), script);
  await assert.rejects(
    provider.run(makeJob(input, 'sidecar-killed'), makeOptions(dir), makeContext([])),
    (error) => error.code === 'SIDECAR_CRASHED'
  );
});

test('sidecar provider can cancel a running process', async () => {
  const dir = tempDir();
  const input = makeInput(dir);
  const script = writeStub(dir, 'cancel-sidecar.cjs', `${STUB_HEADER}
emit({ type: 'progress', stage: 'decode', percent: 10, message: 'waiting' });
setTimeout(() => {}, 10000);
`);
  const provider = new SidecarProvider(sidecarConfig(dir, process.execPath), script);
  const promise = provider.run(makeJob(input, 'sidecar-cancel'), makeOptions(dir), makeContext([]));
  const rejection = assert.rejects(promise, (error) => error.code === 'CANCELLED');
  await delay(220);
  await provider.cancel('sidecar-cancel');
  await rejection;
});

test('sidecar provider maps a missing interpreter to SIDECAR_NOT_FOUND', async () => {
  const dir = tempDir();
  const input = makeInput(dir);
  const provider = new SidecarProvider(
    sidecarConfig(dir, path.join(dir, 'missing-python.exe')),
    writeStub(dir, 'missing-sidecar.cjs', 'process.exit(0);\n')
  );
  await assert.rejects(
    provider.run(makeJob(input, 'sidecar-missing'), makeOptions(dir), makeContext([])),
    (error) => error.code === 'SIDECAR_NOT_FOUND'
  );
});

test('service converts a provider timeout into a TIMEOUT response', async () => {
  const dir = tempDir();
  const input = makeInput(dir);
  fs.writeFileSync(path.join(dir, 'motion-capture.json'), JSON.stringify({
    version: 1,
    provider: 'mock',
    modelDir: '',
    device: 'cpu',
    outputFormat: 'bvh',
    fps: 30,
    keepRootMotion: true,
    outputDir: path.join(dir, 'out'),
    pythonPath: 'python',
    timeoutSeconds: 1
  }));
  const MotionCaptureService = loadServiceWithElectron(dir);
  const service = new MotionCaptureService(() => null);
  const response = await service.start(input, { inputPath: input });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'TIMEOUT');
  assert.ok(response.logPath.endsWith('.log'));
  service.dispose();
});

test('service keeps BVH as the internal format when FBX is the default export', async () => {
  const dir = tempDir();
  const input = makeInput(dir);
  fs.writeFileSync(path.join(dir, 'motion-capture.json'), JSON.stringify({
    version: 1,
    provider: 'mock',
    modelDir: '',
    device: 'cpu',
    outputFormat: 'fbx',
    fps: 30,
    keepRootMotion: true,
    outputDir: path.join(dir, 'out'),
    pythonPath: 'python',
    timeoutSeconds: 30
  }));
  const MotionCaptureService = loadServiceWithElectron(dir);
  const service = new MotionCaptureService(() => null);
  const response = await service.start(input, { inputPath: input });
  assert.equal(response.ok, true);
  assert.equal(response.result.format, 'bvh');
  assert.ok(response.result.outputPath.endsWith('.bvh'));
  service.dispose();
});
