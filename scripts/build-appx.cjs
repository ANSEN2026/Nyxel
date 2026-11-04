const fs = require('node:fs');
const path = require('node:path');
const { build, Platform } = require('electron-builder');

const root = path.resolve(__dirname, '..');
const packageJson = require(path.join(root, 'package.json'));
const identityFile = path.join(root, 'store', 'identity.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const saved = fs.existsSync(identityFile) ? readJson(identityFile) : {};
const identity = {
  identityName: process.env.NYXEL_STORE_IDENTITY_NAME || saved.identityName || '',
  publisher: process.env.NYXEL_STORE_PUBLISHER || saved.publisher || '',
  publisherDisplayName:
    process.env.NYXEL_STORE_PUBLISHER_DISPLAY_NAME ||
    saved.publisherDisplayName ||
    'Nyxel'
};

const missing = ['identityName', 'publisher'].filter((key) => !String(identity[key] || '').trim());
if (missing.length) {
  console.error('');
  console.error('缺少 Microsoft Store 应用身份信息：' + missing.join('、'));
  console.error('');
  console.error('请先在 Partner Center 预留应用名，然后在「产品标识 / Product identity」里复制：');
  console.error('  Package/Identity/Name          -> identityName');
  console.error('  Package/Identity/Publisher     -> publisher');
  console.error('  Package/Properties/PublisherDisplayName -> publisherDisplayName');
  console.error('');
  console.error('把三项写入 store/identity.json，或设置环境变量：');
  console.error('  NYXEL_STORE_IDENTITY_NAME');
  console.error('  NYXEL_STORE_PUBLISHER');
  console.error('  NYXEL_STORE_PUBLISHER_DISPLAY_NAME');
  console.error('');
  console.error('模板见 store/identity.example.json。');
  process.exit(1);
}

const prereleaseNumber = String(packageJson.version).match(/-alpha\.(\d+)$/)?.[1];
const storeBuildNumber = process.env.NYXEL_STORE_BUILD_NUMBER || prereleaseNumber || '0';

const config = JSON.parse(JSON.stringify(packageJson.build || {}));
config.buildNumber = storeBuildNumber;
config.win = {
  ...(config.win || {}),
  target: ['appx']
};
config.appx = {
  applicationId: 'Nyxel',
  displayName: 'Nyxel',
  identityName: identity.identityName,
  publisher: identity.publisher,
  publisherDisplayName: identity.publisherDisplayName,
  languages: ['zh-CN', 'en-US'],
  backgroundColor: '#0b0d12',
  setBuildNumber: true,
  minVersion: '10.0.17763.0',
  maxVersionTested: '10.0.22621.0',
  artifactName: 'Nyxel-${version}-${arch}.appx',
  ...(config.appx || {})
};

console.log(`Microsoft Store 打包：${identity.publisherDisplayName} / ${identity.identityName}`);

build({
  targets: Platform.WINDOWS.createTarget(['appx']),
  config
})
  .then((artifacts) => {
    for (const artifact of artifacts) {
      console.log(`APPX 输出：${artifact}`);
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
