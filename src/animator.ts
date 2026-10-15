import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";

/** Emotion presets supported across VRM 0.x and 1.0 models. */
export type EmotionName =
  | "neutral"
  | "happy"
  | "angry"
  | "sorrow"
  | "sad"
  | "surprised"
  | "relaxed";

/** Supported skeletal gesture triggers. */
export type GestureName = "nod" | "shake_head" | "tilt_head" | "wave" | "shrug";

/** Supported phonetic visemes for mouth articulation. */
export const ALL_VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;
export type AvatarViseme = (typeof ALL_VISEMES)[number];

export type GestureTerminalStatus = "completed" | "cancelled" | "failed";

export interface GestureTerminalResult {
  commandId?: string;
  name: GestureName;
  status: GestureTerminalStatus;
  error?: string;
}

export type GestureTerminalCallback = (result: GestureTerminalResult) => void;
export type GestureCompleteCallback = (name: GestureName) => void;

const EMOTION_PRESETS: readonly string[] = [
  "happy",
  "angry",
  "sorrow",
  "sad",
  "surprised",
  "relaxed",
];

// Idle breathing & sway rates
const BREATH_FREQUENCY = 2.0;
const SWAY_FREQUENCY = 0.8;
const BLINK_INTERVAL_MIN_SECONDS = 3.0;
const BLINK_INTERVAL_MAX_SECONDS = 6.0;
const BLINK_DURATION_SECONDS = 0.25;
const GAZE_SMOOTHING_RATE = 10.0;
const GAZE_HORIZONTAL_RANGE = 0.7;
const GAZE_VERTICAL_RANGE = 0.4;
const GAZE_DISTANCE = 0.9;
const LIP_SYNC_ATTACK_RATE = 25.0;
const LIP_SYNC_RELEASE_RATE = 10.0;
const EMOTION_FADE_RATE = 6.0;
const FALLBACK_HEAD_POSITION = new THREE.Vector3(0, 1.4, 0);

const GESTURE_DURATIONS: Record<GestureName, number> = {
  nod: 1.2,
  shake_head: 1.2,
  tilt_head: 1.5,
  shrug: 1.4,
  wave: 2.0,
};

interface BreathingBone {
  node: THREE.Object3D;
  baseRotationX: number;
  baseRotationZ: number;
  amplitudeX: number;
  amplitudeZ: number;
}

interface BoneTransformBase {
  node: THREE.Object3D;
  baseX: number;
  baseY: number;
  baseZ: number;
}

interface RelaxedBone {
  node: THREE.Object3D;
  restX: number;
  restY: number;
  restZ: number;
  isRightArm?: boolean;
}

function smoothstep(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function exponentialDamp(current: number, target: number, rate: number, delta: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-rate * delta));
}

function nextBlinkDelay(): number {
  return (
    BLINK_INTERVAL_MIN_SECONDS +
    Math.random() * (BLINK_INTERVAL_MAX_SECONDS - BLINK_INTERVAL_MIN_SECONDS)
  );
}

interface ActiveGesture {
  name: GestureName;
  commandId?: string;
  elapsed: number;
  duration: number;
}

/**
 * Procedural animator for VRM avatars:
 * - Deterministic, non-integrating bone pose composition: base + sway/breath + gesture.
 * - Robust cancellation and completion events correlated by command_id.
 * - Natural resting posture for arms, hands, and curled fingers.
 * - Organic breathing and weight-shift body sway.
 * - Saccadic micro-movements of eyes to eliminate the lifeless stare.
 * - Smooth blinking, gaze tracking, and lipsync.
 * - Universal emotion mapping compatible with VRM 0.x and 1.0.
 */
export class VrmAnimator {
  private readonly vrm: VRM;
  private readonly scene: THREE.Scene;
  private readonly lookAtTarget = new THREE.Object3D();
  private readonly gazeGoal = new THREE.Vector2(0, 0);
  private readonly gazeCurrent = new THREE.Vector2(0, 0);
  private readonly headWorldPosition = new THREE.Vector3();
  private readonly breathingBones: BreathingBone[] = [];

  // Body & Arm bones with base transforms
  private hipsBone: THREE.Object3D | null = null;
  private headBone: BoneTransformBase | null = null;
  private leftShoulder: BoneTransformBase | null = null;
  private rightShoulder: BoneTransformBase | null = null;
  private leftUpperArm: BoneTransformBase | null = null;
  private rightUpperArm: BoneTransformBase | null = null;
  private leftLowerArm: BoneTransformBase | null = null;
  private rightLowerArm: BoneTransformBase | null = null;
  private readonly fingerBones: RelaxedBone[] = [];

  // Eye Saccades (involuntary micro-movements)
  private saccadeTimer = 1.0;
  private readonly saccadeCurrent = new THREE.Vector2(0, 0);
  private readonly saccadeGoal = new THREE.Vector2(0, 0);

  // Active procedural gesture
  private activeGesture: ActiveGesture | null = null;
  private onGestureComplete?: GestureCompleteCallback;
  private onGestureTerminal?: GestureTerminalCallback;

  // Gesture contribution offsets (per-frame computed from active gesture)
  private gestureHeadPitch = 0;
  private gestureHeadYaw = 0;
  private gestureHeadRoll = 0;
  private gestureLeftShoulderZ = 0;
  private gestureRightShoulderZ = 0;
  private gestureWaveEnvelope = 0;
  private gestureWaveProgress = 0;

  private elapsed = 0;
  private blinkDelay = nextBlinkDelay();
  private blinkTime: number | null = null;
  private blinkWeight = 0;
  private lipSyncTarget = 0;
  private lipSyncValue = 0;
  private lipSyncViseme: AvatarViseme = "aa";
  private readonly emotionValues = new Map<string, number>();
  private readonly emotionGoals = new Map<string, number>();

  constructor(vrm: VRM, scene: THREE.Scene) {
    this.vrm = vrm;
    this.scene = scene;

    scene.add(this.lookAtTarget);
    if (vrm.lookAt) {
      vrm.lookAt.target = this.lookAtTarget;
    }

    this.registerBreathingBone("spine", 0.012, 0.0);
    this.registerBreathingBone("chest", 0.02, 0.0);
    this.registerBreathingBone("neck", 0.008, 0.006);

    this.initNaturalBodyPose();

    for (const preset of EMOTION_PRESETS) {
      this.emotionValues.set(preset, 0);
      this.emotionGoals.set(preset, 0);
    }
  }

  /** Set the gaze target in normalized screen coordinates [-1, 1]; positive Y looks up. */
  setGazeTarget(x: number, y: number): void {
    this.gazeGoal.set(THREE.MathUtils.clamp(x, -1, 1), THREE.MathUtils.clamp(y, -1, 1));
  }

  /** Drive mouth opening from an audio RMS amplitude in [0, 1] and an optional viseme phonetic morph target. */
  setLipSync(rms: number, viseme?: AvatarViseme | null): void {
    this.lipSyncTarget = THREE.MathUtils.clamp(rms, 0, 1);
    this.lipSyncViseme = viseme ?? "aa";
  }

  get currentViseme(): AvatarViseme {
    return this.lipSyncViseme;
  }

  /** Cross-fade emotion presets toward the requested expression. */
  setExpression(name: EmotionName, weight = 1.0): void {
    const target = THREE.MathUtils.clamp(weight, 0, 1);
    const normalized = name === "sorrow" ? "sad" : name;

    for (const preset of EMOTION_PRESETS) {
      const isTarget =
        preset === normalized || (normalized === "sad" && (preset === "sorrow" || preset === "sad"));
      this.emotionGoals.set(preset, isTarget ? target : 0);
    }
  }

  /** Start a blink immediately instead of waiting for the automatic timer. */
  triggerBlink(): void {
    if (this.blinkTime === null) {
      this.blinkTime = 0;
    }
  }

  /**
   * Triggers a physical body or head gesture.
   * If a gesture is already playing, cancels it cleanly with a terminal callback.
   */
  triggerGesture(name: GestureName, commandId?: string): void {
    if (this.activeGesture) {
      const prev = this.activeGesture;
      this.activeGesture = null;
      this.onGestureTerminal?.({
        commandId: prev.commandId,
        name: prev.name,
        status: "cancelled",
      });
    }

    const duration = GESTURE_DURATIONS[name] ?? 1.2;
    this.activeGesture = { name, commandId, elapsed: 0, duration };
  }

  /** Stops any currently playing gesture immediately and cleanly restores resting pose. */
  stopGesture(commandId?: string): void {
    if (this.activeGesture) {
      if (commandId && this.activeGesture.commandId && this.activeGesture.commandId !== commandId) {
        return;
      }
      const prev = this.activeGesture;
      this.activeGesture = null;
      this.resetGestureOffsets();
      this.onGestureTerminal?.({
        commandId: prev.commandId,
        name: prev.name,
        status: "cancelled",
      });
    }
  }


  /** Register callback invoked when a gesture reaches terminal state (completed or cancelled). */
  setGestureTerminalCallback(callback: GestureTerminalCallback): void {
    this.onGestureTerminal = callback;
  }

  /** Register callback invoked when a gesture finishes naturally (backwards compatibility). */
  setGestureCompleteCallback(callback: GestureCompleteCallback): void {
    this.onGestureComplete = callback;
  }

  get currentGesture(): GestureName | null {
    return this.activeGesture?.name ?? null;
  }

  get currentGestureCommandId(): string | undefined {
    return this.activeGesture?.commandId;
  }

  update(delta: number): void {
    this.elapsed += delta;
    this.updateGestures(delta);
    this.updateBreathing();
    this.updateBodySway();
    this.updateArms(delta);
    this.updateHeadPose();
    this.updateBlink(delta);
    this.updateSaccades(delta);
    this.updateGaze(delta);
    this.updateLipSync(delta);
    this.updateEmotions(delta);
  }

  dispose(): void {
    if (this.activeGesture) {
      this.stopGesture();
    }
    if (this.vrm.lookAt) {
      this.vrm.lookAt.target = null;
    }
    this.scene.remove(this.lookAtTarget);
  }

  private registerBreathingBone(
    boneName: VRMHumanBoneName,
    amplitudeX: number,
    amplitudeZ: number,
  ): void {
    const node = this.vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;
    this.breathingBones.push({
      node,
      baseRotationX: node.rotation.x,
      baseRotationZ: node.rotation.z,
      amplitudeX,
      amplitudeZ,
    });
  }

  private registerFinger(
    boneName: VRMHumanBoneName,
    restX: number,
    restY: number,
    restZ: number,
    isRightArm = false,
  ): void {
    const node = this.vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;
    node.rotation.set(restX, restY, restZ);
    this.fingerBones.push({ node, restX, restY, restZ, isRightArm });
  }

  /** Brings arms, hands, and fingers into a natural relaxed human resting posture. */
  private initNaturalBodyPose(): void {
    this.hipsBone = this.vrm.humanoid.getNormalizedBoneNode("hips");

    const head = this.vrm.humanoid.getNormalizedBoneNode("head");
    if (head) {
      this.headBone = {
        node: head,
        baseX: head.rotation.x,
        baseY: head.rotation.y,
        baseZ: head.rotation.z,
      };
    }

    const ls = this.vrm.humanoid.getNormalizedBoneNode("leftShoulder");
    if (ls) {
      this.leftShoulder = { node: ls, baseX: ls.rotation.x, baseY: ls.rotation.y, baseZ: ls.rotation.z };
    }
    const rs = this.vrm.humanoid.getNormalizedBoneNode("rightShoulder");
    if (rs) {
      this.rightShoulder = { node: rs, baseX: rs.rotation.x, baseY: rs.rotation.y, baseZ: rs.rotation.z };
    }

    // The normalized rig keeps the model's rest-bone positions. VRM 0.x
    // and 1.0 can extend their arms along opposite X directions; rotating
    // the scene with rotateVRM0 does not change these local coordinates.
    const restingArmZ = (lowerArmName: VRMHumanBoneName, fallback: number): number => {
      const directionX = this.vrm.humanoid.getNormalizedBoneNode(lowerArmName)?.position.x ?? 0;
      return Math.abs(directionX) > 1e-6 ? -Math.sign(directionX) * 1.47 : fallback;
    };

    // Lower both arms ~84.5 degrees along the body, with relaxed elbows.
    const lua = this.vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
    if (lua) {
      this.leftUpperArm = { node: lua, baseX: 0.10, baseY: -0.05, baseZ: restingArmZ("leftLowerArm", -1.47) };
    }
    const rua = this.vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
    if (rua) {
      this.rightUpperArm = { node: rua, baseX: 0.10, baseY: 0.05, baseZ: restingArmZ("rightLowerArm", 1.47) };
    }

    const lla = this.vrm.humanoid.getNormalizedBoneNode("leftLowerArm");
    if (lla) {
      this.leftLowerArm = { node: lla, baseX: 0.16, baseY: -0.10, baseZ: 0.0 };
    }
    const rla = this.vrm.humanoid.getNormalizedBoneNode("rightLowerArm");
    if (rla) {
      this.rightLowerArm = { node: rla, baseX: 0.16, baseY: 0.10, baseZ: 0.0 };
    }

    // Natural relaxed hand tilt
    this.registerFinger("leftHand", 0.05, -0.05, -0.08, false);
    this.registerFinger("rightHand", 0.05, 0.05, 0.08, true);

    // Natural finger curls for Left Hand
    this.registerFinger("leftThumbProximal", 0.08, -0.15, -0.22, false);
    this.registerFinger("leftThumbDistal", 0.0, 0.0, -0.18, false);
    this.registerFinger("leftIndexProximal", 0.0, 0.0, -0.25, false);
    this.registerFinger("leftIndexIntermediate", 0.0, 0.0, -0.22, false);
    this.registerFinger("leftIndexDistal", 0.0, 0.0, -0.15, false);
    this.registerFinger("leftMiddleProximal", 0.0, 0.0, -0.28, false);
    this.registerFinger("leftMiddleIntermediate", 0.0, 0.0, -0.25, false);
    this.registerFinger("leftMiddleDistal", 0.0, 0.0, -0.18, false);
    this.registerFinger("leftRingProximal", 0.0, 0.0, -0.32, false);
    this.registerFinger("leftRingIntermediate", 0.0, 0.0, -0.28, false);
    this.registerFinger("leftRingDistal", 0.0, 0.0, -0.2, false);
    this.registerFinger("leftLittleProximal", 0.0, 0.0, -0.35, false);
    this.registerFinger("leftLittleIntermediate", 0.0, 0.0, -0.3, false);
    this.registerFinger("leftLittleDistal", 0.0, 0.0, -0.22, false);

    // Natural finger curls for Right Hand
    this.registerFinger("rightThumbProximal", 0.08, 0.15, 0.22, true);
    this.registerFinger("rightThumbDistal", 0.0, 0.0, 0.18, true);
    this.registerFinger("rightIndexProximal", 0.0, 0.0, 0.25, true);
    this.registerFinger("rightIndexIntermediate", 0.0, 0.0, 0.22, true);
    this.registerFinger("rightIndexDistal", 0.0, 0.0, 0.15, true);
    this.registerFinger("rightMiddleProximal", 0.0, 0.0, 0.28, true);
    this.registerFinger("rightMiddleIntermediate", 0.0, 0.0, 0.25, true);
    this.registerFinger("rightMiddleDistal", 0.0, 0.0, 0.18, true);
    this.registerFinger("rightRingProximal", 0.0, 0.0, 0.32, true);
    this.registerFinger("rightRingIntermediate", 0.0, 0.0, 0.28, true);
    this.registerFinger("rightRingDistal", 0.0, 0.0, 0.2, true);
    this.registerFinger("rightLittleProximal", 0.0, 0.0, 0.35, true);
    this.registerFinger("rightLittleIntermediate", 0.0, 0.0, 0.3, true);
    this.registerFinger("rightLittleDistal", 0.0, 0.0, 0.22, true);
  }

  private resetGestureOffsets(): void {
    this.gestureHeadPitch = 0;
    this.gestureHeadYaw = 0;
    this.gestureHeadRoll = 0;
    this.gestureLeftShoulderZ = 0;
    this.gestureRightShoulderZ = 0;
    this.gestureWaveEnvelope = 0;
    this.gestureWaveProgress = 0;
  }

  /** Evaluates active procedural gesture and sets non-accumulating offset terms. */
  private updateGestures(delta: number): void {
    if (!this.activeGesture) {
      this.resetGestureOffsets();
      return;
    }

    this.activeGesture.elapsed += delta;
    const progress = Math.min(1, this.activeGesture.elapsed / this.activeGesture.duration);
    const envelope = Math.sin(progress * Math.PI);

    const { name } = this.activeGesture;

    this.resetGestureOffsets();

    if (name === "nod") {
      this.gestureHeadPitch = Math.sin(progress * Math.PI * 4) * 0.22 * envelope;
    } else if (name === "shake_head") {
      this.gestureHeadYaw = Math.sin(progress * Math.PI * 4) * 0.25 * envelope;
    } else if (name === "tilt_head") {
      this.gestureHeadRoll = 0.22 * envelope;
    } else if (name === "shrug") {
      const shrugHeight = 0.12 * envelope;
      this.gestureLeftShoulderZ = -shrugHeight;
      this.gestureRightShoulderZ = shrugHeight;
    } else if (name === "wave") {
      this.gestureWaveEnvelope = envelope;
      this.gestureWaveProgress = progress;
    }

    if (progress >= 1) {
      const finished = this.activeGesture;
      this.activeGesture = null;
      this.resetGestureOffsets();
      this.onGestureTerminal?.({
        commandId: finished.commandId,
        name: finished.name,
        status: "completed",
      });
      this.onGestureComplete?.(finished.name);
    }
  }

  private updateBreathing(): void {
    const breath = Math.sin(this.elapsed * BREATH_FREQUENCY);
    for (const bone of this.breathingBones) {
      bone.node.rotation.x = bone.baseRotationX + breath * bone.amplitudeX;
      bone.node.rotation.z = bone.baseRotationZ + breath * bone.amplitudeZ;
    }
  }

  /** Subtle weight shift and hip sway. */
  private updateBodySway(): void {
    if (!this.hipsBone) return;
    const sway = Math.sin(this.elapsed * SWAY_FREQUENCY);
    this.hipsBone.rotation.z = sway * 0.015;
    this.hipsBone.rotation.y = Math.sin(this.elapsed * (SWAY_FREQUENCY * 0.5)) * 0.01;
  }

  /** Deterministic composition of head pose: base + breath sway + gesture. */
  private updateHeadPose(): void {
    if (!this.headBone) return;
    const breath = Math.sin(this.elapsed * BREATH_FREQUENCY);
    const breathHeadZ = breath * 0.015;

    this.headBone.node.rotation.x = this.headBone.baseX + this.gestureHeadPitch;
    this.headBone.node.rotation.y = this.headBone.baseY + this.gestureHeadYaw;
    this.headBone.node.rotation.z = this.headBone.baseZ + breathHeadZ + this.gestureHeadRoll;
  }

  /** Maintains relaxed arm & shoulder posture + breathing chest sync + hand poses. */
  private updateArms(_delta: number): void {
    const breathArmSway = Math.sin(this.elapsed * BREATH_FREQUENCY) * 0.015;

    // Shoulders: base + shrug offset
    if (this.leftShoulder) {
      this.leftShoulder.node.rotation.x = this.leftShoulder.baseX;
      this.leftShoulder.node.rotation.y = this.leftShoulder.baseY;
      this.leftShoulder.node.rotation.z = this.leftShoulder.baseZ + this.gestureLeftShoulderZ;
    }
    if (this.rightShoulder) {
      this.rightShoulder.node.rotation.x = this.rightShoulder.baseX;
      this.rightShoulder.node.rotation.y = this.rightShoulder.baseY;
      this.rightShoulder.node.rotation.z = this.rightShoulder.baseZ + this.gestureRightShoulderZ;
    }

    // Left arm: always at resting pose + breath sway
    if (this.leftUpperArm) {
      this.leftUpperArm.node.rotation.x = this.leftUpperArm.baseX + breathArmSway * 0.5;
      this.leftUpperArm.node.rotation.y = this.leftUpperArm.baseY;
      this.leftUpperArm.node.rotation.z = this.leftUpperArm.baseZ - breathArmSway;
    }
    if (this.leftLowerArm) {
      this.leftLowerArm.node.rotation.x = this.leftLowerArm.baseX;
      this.leftLowerArm.node.rotation.y = this.leftLowerArm.baseY;
      this.leftLowerArm.node.rotation.z = this.leftLowerArm.baseZ;
    }

    // Right arm: resting pose + breath sway, or wave composition
    if (this.rightUpperArm) {
      if (this.gestureWaveEnvelope > 0) {
        this.rightUpperArm.node.rotation.x = THREE.MathUtils.lerp(
          this.rightUpperArm.baseX,
          0.6,
          this.gestureWaveEnvelope,
        );
        this.rightUpperArm.node.rotation.y = this.rightUpperArm.baseY;
        this.rightUpperArm.node.rotation.z = THREE.MathUtils.lerp(
          this.rightUpperArm.baseZ,
          -Math.sign(this.rightUpperArm.baseZ) * 0.4,
          this.gestureWaveEnvelope,
        );
      } else {
        this.rightUpperArm.node.rotation.x = this.rightUpperArm.baseX + breathArmSway * 0.5;
        this.rightUpperArm.node.rotation.y = this.rightUpperArm.baseY;
        this.rightUpperArm.node.rotation.z = this.rightUpperArm.baseZ + breathArmSway;
      }
    }

    if (this.rightLowerArm) {
      if (this.gestureWaveEnvelope > 0) {
        this.rightLowerArm.node.rotation.x = THREE.MathUtils.lerp(
          this.rightLowerArm.baseX,
          0.9,
          this.gestureWaveEnvelope,
        );
        this.rightLowerArm.node.rotation.y = this.rightLowerArm.baseY;
        this.rightLowerArm.node.rotation.z =
          Math.sin(this.gestureWaveProgress * Math.PI * 8) * 0.3 * this.gestureWaveEnvelope;
      } else {
        this.rightLowerArm.node.rotation.x = this.rightLowerArm.baseX;
        this.rightLowerArm.node.rotation.y = this.rightLowerArm.baseY;
        this.rightLowerArm.node.rotation.z = this.rightLowerArm.baseZ;
      }
    }

    // Fingers: relaxed curled pose, slightly uncurled during wave
    for (const finger of this.fingerBones) {
      if (finger.isRightArm && this.gestureWaveEnvelope > 0) {
        finger.node.rotation.z = THREE.MathUtils.lerp(
          finger.restZ,
          finger.restZ * 0.35,
          this.gestureWaveEnvelope,
        );
      } else {
        finger.node.rotation.x = finger.restX;
        finger.node.rotation.y = finger.restY;
        finger.node.rotation.z = finger.restZ;
      }
    }
  }

  private updateBlink(delta: number): void {
    if (this.blinkTime === null) {
      this.blinkDelay -= delta;
      if (this.blinkDelay <= 0) {
        this.blinkTime = 0;
      }
    }

    if (this.blinkTime === null) {
      this.blinkWeight = 0;
    } else {
      this.blinkTime += delta;
      const progress = this.blinkTime / BLINK_DURATION_SECONDS;
      if (progress < 0.3) {
        this.blinkWeight = smoothstep(progress / 0.3);
      } else if (progress < 0.8) {
        this.blinkWeight = 1;
      } else if (progress < 1) {
        this.blinkWeight = 1 - smoothstep((progress - 0.8) / 0.2);
      } else {
        this.blinkWeight = 0;
        this.blinkTime = null;
        this.blinkDelay = nextBlinkDelay();
      }
    }

    this.setExpressionValue("blink", this.blinkWeight);
  }

  /** Involuntary micro-saccades to give realistic liveliness to eyes. */
  private updateSaccades(delta: number): void {
    this.saccadeTimer -= delta;
    if (this.saccadeTimer <= 0) {
      this.saccadeTimer = 0.8 + Math.random() * 1.6;
      const angle = Math.random() * Math.PI * 2;
      const dist = 0.015 + Math.random() * 0.025;
      this.saccadeGoal.set(Math.cos(angle) * dist, Math.sin(angle) * dist * 0.6);
    }
    this.saccadeCurrent.lerp(this.saccadeGoal, 1 - Math.exp(-30.0 * delta));
  }

  private updateGaze(delta: number): void {
    if (!this.vrm.lookAt) return;

    this.gazeCurrent.lerp(this.gazeGoal, 1 - Math.exp(-GAZE_SMOOTHING_RATE * delta));

    const head = this.vrm.humanoid.getRawBoneNode("head");
    if (head) {
      head.getWorldPosition(this.headWorldPosition);
    } else {
      this.headWorldPosition.copy(FALLBACK_HEAD_POSITION);
    }

    const effectiveX = THREE.MathUtils.clamp(this.gazeCurrent.x + this.saccadeCurrent.x, -1, 1);
    const effectiveY = THREE.MathUtils.clamp(this.gazeCurrent.y + this.saccadeCurrent.y, -1, 1);

    this.lookAtTarget.position.set(
      this.headWorldPosition.x + effectiveX * GAZE_HORIZONTAL_RANGE,
      this.headWorldPosition.y + effectiveY * GAZE_VERTICAL_RANGE,
      this.headWorldPosition.z + GAZE_DISTANCE,
    );
    this.lookAtTarget.updateWorldMatrix(true, false);
  }

  private updateLipSync(delta: number): void {
    const rate = this.lipSyncTarget > this.lipSyncValue ? LIP_SYNC_ATTACK_RATE : LIP_SYNC_RELEASE_RATE;
    this.lipSyncValue = exponentialDamp(this.lipSyncValue, this.lipSyncTarget, rate, delta);
    for (const v of ALL_VISEMES) {
      if (v === this.lipSyncViseme) {
        this.vrm.expressionManager?.setValue(v, this.lipSyncValue);
      } else {
        this.vrm.expressionManager?.setValue(v, 0);
      }
    }
  }

  private updateEmotions(delta: number): void {
    for (const preset of EMOTION_PRESETS) {
      const current = this.emotionValues.get(preset) ?? 0;
      const goal = this.emotionGoals.get(preset) ?? 0;
      const value = exponentialDamp(current, goal, EMOTION_FADE_RATE, delta);
      this.emotionValues.set(preset, value);
      this.setExpressionValue(preset, value);
    }
  }

  private setExpressionValue(name: string, weight: number): void {
    this.vrm.expressionManager?.setValue(name, weight);
    // Cross-map sad and sorrow so both VRM 0.x and 1.0 models work reliably
    if (name === "sad") {
      this.vrm.expressionManager?.setValue("sorrow", weight);
    } else if (name === "sorrow") {
      this.vrm.expressionManager?.setValue("sad", weight);
    }
  }
}
