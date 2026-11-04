# Microsoft Store 发布说明

Nyxel 使用 electron-builder 的 `appx` 目标生成 Microsoft Store 可接受的 `.appx` 包。Store 会重新签名，因此打包阶段不需要购买代码签名证书。

## 1. 注册开发者账号

1. 打开 https://storedeveloper.microsoft.com
2. 选择 **Individual developer**（个人开发者）。
3. 使用 Microsoft 账号登录。
4. 按页面提示完成政府证件 + 自拍验证。
5. 进入 Partner Center。

个人开发者注册目前免注册费，具体以 Microsoft 页面为准。

## 2. 预留应用名称并复制身份信息

在 Partner Center 创建应用、预留名称 **Nyxel**，然后打开：

**应用 → 产品标识 / Product identity**

复制下面三项：

| Partner Center 字段 | 配置字段 |
| --- | --- |
| Package/Identity/Name | `identityName` |
| Package/Identity/Publisher | `publisher` |
| Package/Properties/PublisherDisplayName | `publisherDisplayName` |

把值写入 `store/identity.json`（该文件已被 `.gitignore` 忽略）：

```json
{
  "identityName": "从 Partner Center 复制",
  "publisher": "CN=从 Partner Center 复制",
  "publisherDisplayName": "Nyxel"
}
```

也可以改用环境变量：

```
NYXEL_STORE_IDENTITY_NAME
NYXEL_STORE_PUBLISHER
NYXEL_STORE_PUBLISHER_DISPLAY_NAME
```

## 3. 打包

```bash
npm run dist:appx
```

输出在 `release/`：

```
Nyxel-<version>-x64.appx
```

AppX 版本由 `major.minor.patch` 加构建号组成。当前 Alpha 版本号中的 `alpha.N` 会自动作为构建号，例如 `0.2.0-alpha.13` → `0.2.13.0`。需要手动指定时设置：

```powershell
$env:NYXEL_STORE_BUILD_NUMBER = "14"
npm run dist:appx
```

> Store 每次更新都必须使用比上一次更高的版本号。

## 4. 上传

1. Partner Center 中打开 Nyxel。
2. **Packages / 包** → 上传 `.appx`。
3. 按提示填写：
   - 应用描述、分类、系统要求
   - 至少 1 张桌面截图（建议 3–5 张）
   - 隐私政策 URL（如果收集任何数据；Nyxel 当前主要数据保存在本机）
   - 年龄分级问卷
   - 商店展示图：300×300 应用图标、截图等
4. 提交认证。

Store MSIX 版本由商店自动更新，应用内的「检查更新」会显示为「商店版本自动更新」，不会跳转到 GitHub Releases。

## 5. 认证前注意

- 视频压缩和 AI 超分会在首次使用时下载外部运行时（ffmpeg / Upscayl / Real-ESRGAN）。提交时建议在「认证说明」里写明下载用途、用户触发方式、保存位置和离线可用性。
- 如果认证团队认为外部运行时下载不符合 Store 策略，需要改为把运行时随包分发，或在 Store 版本中隐藏对应功能。
- 截图全局热键、桌面捕获、写入 `Documents\Nyxel\Library` 都是桌面应用能力，需要在认证说明中写清楚。
- 上传前用 Windows App Certification Kit 检查一次 MSIX。

## 当前状态

`scripts/build-appx.cjs` 和 `build/appx` 图标资源已经准备好。没有 `store/identity.json` 时会提示缺少身份信息，不会误打包成可提交的包。
