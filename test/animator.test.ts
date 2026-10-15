import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { VRMHumanoid, type VRMHumanBoneName } from "@pixiv/three-vrm";
import { VrmAnimator, ALL_VISEMES } from "../src/animator";

function createMockBone(name: string): THREE.Object3D {
  const bone = new THREE.Object3D();
  bone.name = name;
  return bone;
}

function createMockVrm() {
  const bones: Record<string, THREE.Object3D> = {
    spine: createMockBone("spine"),
    chest: createMockBone("chest"),
    neck: createMockBone("neck"),
    head: createMockBone("head"),
    hips: createMockBone("hips"),
    leftShoulder: createMockBone("leftShoulder"),
    rightShoulder: createMockBone("rightShoulder"),
    leftUpperArm: createMockBone("leftUpperArm"),
    rightUpperArm: createMockBone("rightUpperArm"),
    leftLowerArm: createMockBone("leftLowerArm"),
    rightLowerArm: createMockBone("rightLowerArm"),
    leftHand: createMockBone("leftHand"),
    rightHand: createMockBone("rightHand"),
  };

  return {
    humanoid: {
      getNormalizedBoneNode: (name: string) => bones[name] ?? null,
      getRawBoneNode: (name: string) => bones[name] ?? null,
    },
    expressionManager: {
      setValue: vi.fn(),
    },
    lookAt: {
      target: null,
    },
    bones,
  };
}

describe("VrmAnimator gesture composition and interruption", () => {
  it.each([1, -1])("keeps hands below shoulders and restores them after waving (rest X direction %s)", (direction) => {
    // A connected synthetic T-pose rig exercises real three-vrm retargeting
    // in both arm-axis conventions without requiring a user's model file.
    const scene = new THREE.Scene();
    const humanBones: Partial<Record<VRMHumanBoneName, { node: THREE.Object3D }>> = {};
    const bone = (name: VRMHumanBoneName, parent: THREE.Object3D, x: number, y: number) => {
      const node = createMockBone(name);
      node.position.set(x * direction, y, 0);
      parent.add(node);
      humanBones[name] = { node };
      return node;
    };
    const hips = bone("hips", scene, 0, 0.9);
    const spine = bone("spine", hips, 0, 0.2);
    const chest = bone("chest", spine, 0, 0.2);
    const neck = bone("neck", chest, 0, 0.15);
    bone("head", neck, 0, 0.15);
    for (const side of ["left", "right"] as const) {
      const sign = side === "left" ? 1 : -1;
      const shoulder = bone(`${side}Shoulder`, chest, sign * 0.08, 0.1);
      const upperArm = bone(`${side}UpperArm`, shoulder, sign * 0.08, 0);
      const lowerArm = bone(`${side}LowerArm`, upperArm, sign * 0.28, 0);
      bone(`${side}Hand`, lowerArm, sign * 0.25, 0);
      const upperLeg = bone(`${side}UpperLeg`, hips, sign * 0.08, 0);
      const lowerLeg = bone(`${side}LowerLeg`, upperLeg, 0, -0.4);
      bone(`${side}Foot`, lowerLeg, 0, -0.4);
    }
    const humanoid = new VRMHumanoid(humanBones);
    scene.add(humanoid.normalizedHumanBonesRoot);
    scene.rotation.y = Math.PI; // rotateVRM0 must not flip the chosen local arm rotation.
    const animator = new VrmAnimator({ humanoid } as any, scene);
    const height = (bone: VRMHumanBoneName) =>
      humanoid.getRawBoneNode(bone)!.getWorldPosition(new THREE.Vector3()).y;
    const tick = (delta: number) => {
      animator.update(delta);
      humanoid.update();
      scene.updateMatrixWorld(true);
    };
    const expectLoweredArms = () => {
      for (const side of ["left", "right"] as const) {
        expect(height(`${side}LowerArm`)).toBeLessThan(height(`${side}UpperArm`) - 0.18);
        expect(height(`${side}Hand`)).toBeLessThan(height(`${side}UpperArm`) - 0.3);
      }
    };

    tick(1 / 60);
    expectLoweredArms();
    const restHeight = height("rightHand");
    animator.triggerGesture("wave");
    tick(1);
    expect(height("rightHand")).toBeGreaterThan(restHeight + 0.15);
    tick(1.1);
    expectLoweredArms();
    animator.triggerGesture("wave");
    tick(0.5);
    animator.stopGesture();
    tick(1 / 60);
    expectLoweredArms();
    animator.dispose();
  });

  it("shake_head does not accumulate yaw across 100 repeats at 60 FPS and 144 FPS", () => {
    const vrm = createMockVrm();
    const scene = new THREE.Scene();
    const animator = new VrmAnimator(vrm as any, scene);
    const headBone = vrm.bones.head;

    const initialY = headBone.rotation.y;

    // Simulate 10 shake_head cycles at 60 FPS (dt = 1/60s)
    const dt = 1 / 60;
    for (let cycle = 0; cycle < 10; cycle++) {
      animator.triggerGesture("shake_head");
      // 1.2s duration = 72 frames
      for (let f = 0; f < 80; f++) {
        animator.update(dt);
      }
    }

    // After gesture completes, yaw should return exactly to base rotation
    expect(headBone.rotation.y).toBeCloseTo(initialY, 5);

    // Test at 144 FPS
    const dt144 = 1 / 144;
    for (let cycle = 0; cycle < 10; cycle++) {
      animator.triggerGesture("shake_head");
      for (let f = 0; f < 200; f++) {
        animator.update(dt144);
      }
    }
    expect(headBone.rotation.y).toBeCloseTo(initialY, 5);
  });

  it("interrupting shake_head midway with nod immediately returns yaw to base", () => {
    const vrm = createMockVrm();
    const scene = new THREE.Scene();
    const animator = new VrmAnimator(vrm as any, scene);
    const headBone = vrm.bones.head;
    const initialY = headBone.rotation.y;

    const terminalResults: any[] = [];
    animator.setGestureTerminalCallback((res) => terminalResults.push(res));

    // Start shake_head
    animator.triggerGesture("shake_head", "shake-1");
    // Run for 0.15s (frame 9 at 60 FPS, progress 0.125, sin(4*PI*0.125) = sin(PI/2) = 1.0)
    for (let f = 0; f < 9; f++) {
      animator.update(1 / 60);
    }

    // Head is rotated in yaw during the gesture
    expect(Math.abs(headBone.rotation.y - initialY)).toBeGreaterThan(0.01);

    // Now interrupt with nod
    animator.triggerGesture("nod", "nod-1");

    // shake-1 should be cancelled
    expect(terminalResults).toEqual([
      { commandId: "shake-1", name: "shake_head", status: "cancelled" },
    ]);

    // Update 1 frame of nod
    animator.update(1 / 60);

    // Yaw must immediately be back to initialY (no residual turn left over from shake_head!)
    expect(headBone.rotation.y).toBeCloseTo(initialY, 5);
  });

  it("interrupting shrug with nod restores shoulders immediately to base pose", () => {
    const vrm = createMockVrm();
    const scene = new THREE.Scene();
    const animator = new VrmAnimator(vrm as any, scene);
    const leftShoulder = vrm.bones.leftShoulder;
    const rightShoulder = vrm.bones.rightShoulder;
    const initialLeftZ = leftShoulder.rotation.z;
    const initialRightZ = rightShoulder.rotation.z;

    animator.triggerGesture("shrug", "shrug-1");
    // Update to peak of shrug (progress 50% = 0.7s)
    for (let f = 0; f < 42; f++) {
      animator.update(1 / 60);
    }

    // Shoulders elevated
    expect(leftShoulder.rotation.z).not.toBeCloseTo(initialLeftZ, 2);
    expect(rightShoulder.rotation.z).not.toBeCloseTo(initialRightZ, 2);

    // Interrupt with nod
    animator.triggerGesture("nod", "nod-2");
    animator.update(1 / 60);

    // Shoulders must immediately return to base pose
    expect(leftShoulder.rotation.z).toBeCloseTo(initialLeftZ, 5);
    expect(rightShoulder.rotation.z).toBeCloseTo(initialRightZ, 5);
  });

  it("stopGesture with commandId cancels matching active gesture and ignores non-matching", () => {
    const vrm = createMockVrm();
    const scene = new THREE.Scene();
    const animator = new VrmAnimator(vrm as any, scene);
    const terminalResults: any[] = [];
    animator.setGestureTerminalCallback((res) => terminalResults.push(res));

    animator.triggerGesture("nod", "cmd-nod-active");

    // Call stopGesture with stale/different ID -> ignored
    animator.stopGesture("cmd-stale");
    expect(terminalResults.length).toBe(0);

    // Call stopGesture with matching ID -> cancelled
    animator.stopGesture("cmd-nod-active");
    expect(terminalResults).toEqual([
      { commandId: "cmd-nod-active", name: "nod", status: "cancelled" },
    ]);
  });
});

describe("VrmAnimator lipsync and viseme articulation", () => {
  it("defaults to 'aa' morph when no viseme is specified", () => {
    const vrm = createMockVrm();
    const scene = new THREE.Scene();
    const animator = new VrmAnimator(vrm as any, scene);

    animator.setLipSync(0.8);
    expect(animator.currentViseme).toBe("aa");

    animator.update(1 / 60);

    // Active viseme "aa" must receive positive smoothed amplitude
    const setValueMock = vrm.expressionManager.setValue;
    expect(setValueMock).toHaveBeenCalledWith("aa", expect.any(Number));
    const aaCall = setValueMock.mock.calls.find((c) => c[0] === "aa");
    expect(aaCall).toBeDefined();
    expect(aaCall![1]).toBeGreaterThan(0);

    // All inactive visemes must be cleanly zeroed
    for (const viseme of ["ih", "ou", "ee", "oh"]) {
      expect(setValueMock).toHaveBeenCalledWith(viseme, 0);
    }
  });

  it("articulates target phonemes and cleanly switches between visemes", () => {
    const vrm = createMockVrm();
    const scene = new THREE.Scene();
    const animator = new VrmAnimator(vrm as any, scene);
    const setValueMock = vrm.expressionManager.setValue;

    // 1. Target "ee"
    setValueMock.mockClear();
    animator.setLipSync(0.75, "ee");
    expect(animator.currentViseme).toBe("ee");
    animator.update(1 / 60);

    expect(setValueMock).toHaveBeenCalledWith("ee", expect.any(Number));
    const eeCall = setValueMock.mock.calls.find((c) => c[0] === "ee");
    expect(eeCall![1]).toBeGreaterThan(0);
    expect(setValueMock).toHaveBeenCalledWith("aa", 0);
    expect(setValueMock).toHaveBeenCalledWith("ih", 0);
    expect(setValueMock).toHaveBeenCalledWith("ou", 0);
    expect(setValueMock).toHaveBeenCalledWith("oh", 0);

    // 2. Switch to "oh"
    setValueMock.mockClear();
    animator.setLipSync(0.6, "oh");
    expect(animator.currentViseme).toBe("oh");
    animator.update(1 / 60);

    expect(setValueMock).toHaveBeenCalledWith("oh", expect.any(Number));
    const ohCall = setValueMock.mock.calls.find((c) => c[0] === "oh");
    expect(ohCall![1]).toBeGreaterThan(0);
    expect(setValueMock).toHaveBeenCalledWith("aa", 0);
    expect(setValueMock).toHaveBeenCalledWith("ih", 0);
    expect(setValueMock).toHaveBeenCalledWith("ou", 0);
    expect(setValueMock).toHaveBeenCalledWith("ee", 0);

    // 3. Switch back to "aa"
    setValueMock.mockClear();
    animator.setLipSync(0.5, "aa");
    expect(animator.currentViseme).toBe("aa");
    animator.update(1 / 60);

    expect(setValueMock).toHaveBeenCalledWith("aa", expect.any(Number));
    expect(setValueMock).toHaveBeenCalledWith("oh", 0);
  });

  it("supports every phonetic viseme in ALL_VISEMES", () => {
    const vrm = createMockVrm();
    const scene = new THREE.Scene();
    const animator = new VrmAnimator(vrm as any, scene);
    const setValueMock = vrm.expressionManager.setValue;

    for (const viseme of ALL_VISEMES) {
      setValueMock.mockClear();
      animator.setLipSync(0.7, viseme);
      expect(animator.currentViseme).toBe(viseme);

      animator.update(1 / 60);

      const activeCall = setValueMock.mock.calls.find((c) => c[0] === viseme);
      expect(activeCall).toBeDefined();
      expect(activeCall![1]).toBeGreaterThan(0);

      for (const other of ALL_VISEMES) {
        if (other !== viseme) {
          expect(setValueMock).toHaveBeenCalledWith(other, 0);
        }
      }
    }
  });

  it("falls back to 'aa' when viseme is null or undefined", () => {
    const vrm = createMockVrm();
    const scene = new THREE.Scene();
    const animator = new VrmAnimator(vrm as any, scene);

    animator.setLipSync(0.5, "ee");
    expect(animator.currentViseme).toBe("ee");

    animator.setLipSync(0.5, null);
    expect(animator.currentViseme).toBe("aa");

    animator.setLipSync(0.5, undefined);
    expect(animator.currentViseme).toBe("aa");
  });

  it("smoothly decays viseme value to 0 when speech ends (setLipSync(0))", () => {
    const vrm = createMockVrm();
    const scene = new THREE.Scene();
    const animator = new VrmAnimator(vrm as any, scene);
    const setValueMock = vrm.expressionManager.setValue;

    // Open mouth
    animator.setLipSync(1.0, "ou");
    for (let i = 0; i < 10; i++) {
      animator.update(1 / 60);
    }

    const openCall = setValueMock.mock.calls.filter((c) => c[0] === "ou").pop();
    expect(openCall![1]).toBeGreaterThan(0.7);

    // End speech
    animator.setLipSync(0);
    // Allow release smoothing over 0.5s (~30 frames)
    for (let i = 0; i < 30; i++) {
      animator.update(1 / 60);
    }

    const closedCall = setValueMock.mock.calls.filter((c) => c[0] === "ou").pop();
    expect(closedCall![1]).toBeLessThan(0.01);
  });
});


