# UE5 Mannequin 兼容导出与重定向

Texture map 不内置 Epic 官方 Manny / Quinn 资产。动作捕捉的
`FBX · UE5 Mannequin（重定向）` 选项导出一个 **25 骨骼的 UE5 核心骨架**，
供 UE5 IK Retargeter 绑定官方人物模型。

## 导出的骨骼

```text
root
pelvis
spine_01, spine_02, spine_03, spine_04, spine_05
neck_01, head
clavicle_l, upperarm_l, lowerarm_l, hand_l
clavicle_r, upperarm_r, lowerarm_r, hand_r
thigh_l, calf_l, foot_l, ball_l
thigh_r, calf_r, foot_r, ball_r
```

不包含手指、twist、IK 脚 / IK 手骨骼。FBX 为 Z-up 二进制 FBX，包含骨骼和
AnimSequence 曲线，不包含角色网格、蒙皮权重或材质。

## UE5 操作步骤

1. 打开 UE5 项目，Content Browser → Import，选择 Texture map 导出的 `.fbx`。
2. 如果导入器要求选择 Skeleton，选择新建；如果它生成了 Skeletal Mesh / Skeleton，
   命名为 `MC_MannequinRetarget`。
3. 找到官方 Manny / Quinn 的 Skeleton（通常位于
   `Characters/Mannequins/Meshes/SK_Mannequin`）。
4. 右键 → Animation → IK Retargeter，创建 `RTG_TextureMap`：
   - Source：`MC_MannequinRetarget`
   - Target：官方 `SK_Mannequin`
5. 在 Retarget Chain Settings 中建立链：

| Chain | Source | Target |
| --- | --- | --- |
| Root | root | root |
| Spine | pelvis → head | pelvis → head |
| LeftArm | clavicle_l → hand_l | clavicle_l → hand_l |
| RightArm | clavicle_r → hand_r | clavicle_r → hand_r |
| LeftLeg | thigh_l → ball_l | thigh_l → ball_l |
| RightLeg | thigh_r → ball_r | thigh_r → ball_r |

6. 打开 Retarget Pose，选择或自动生成源 / 目标静止姿势，确认预览没有明显扭转。
7. 导出重定向后的 AnimSequence，或直接在 Manny / Quinn 的 Animation Blueprint 中使用。

## 说明

- 源骨架只有 25 个核心骨骼，官方 Mannequin 有更多手指 / twist / IK 骨骼；
  IK Retargeter 会让未映射骨骼保持默认姿势，核心动作仍可传递。
- 由于源骨架和官方骨架的静止姿势、骨长不同，**推荐使用 IK Retargeter**，
  不建议直接把动画导入官方 Skeleton 后期待完全一致。
- 本机没有安装 Unreal Engine，当前只验证了 FBX 结构和 FBXLoader 解析；
  UE5 内的实际导入步骤需要在你的 UE 工程中确认。
