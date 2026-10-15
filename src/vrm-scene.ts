import * as THREE from "three";

export type FrameCallback = (delta: number, elapsed: number) => void;

export type FramingPreset = "face" | "bust" | "half_body" | "full_body";

interface FramingConfig {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

const FRAMING_CONFIGS: Record<FramingPreset, FramingConfig> = {
  face: {
    // Close-up intimate portrait framing
    position: new THREE.Vector3(0, 1.38, 0.68),
    target: new THREE.Vector3(0, 1.35, 0),
    fov: 28,
  },
  bust: {
    // Standard default framing (head and shoulders)
    position: new THREE.Vector3(0, 1.3, 1.2),
    target: new THREE.Vector3(0, 1.25, 0),
    fov: 30,
  },
  half_body: {
    // Waist-up medium shot framing, ideal for hand & arm gestures
    position: new THREE.Vector3(0, 1.15, 1.9),
    target: new THREE.Vector3(0, 1.05, 0),
    fov: 32,
  },
  full_body: {
    // Full body long shot from head to toes
    // Keep the entire avatar above the expanded control panel.
    position: new THREE.Vector3(0, 0.55, 4.8),
    target: new THREE.Vector3(0, 0.5, 0),
    fov: 34,
  },
};

const CAMERA_TRANSITION_SPEED = 6.0;
const MAX_DELTA_SECONDS = 0.1;

export interface VrmScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  addFrameCallback(callback: FrameCallback): void;
  setFraming(preset: FramingPreset, instant?: boolean): void;
  getFraming(): FramingPreset;
  getZoomDistance(): number;
  setZoomDistance(distance: number, instant?: boolean): void;
  zoomBy(factor: number): void;
  dispose(): void;
}

export function createVrmScene(canvas: HTMLCanvasElement): VrmScene {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();

  let activePreset: FramingPreset = "bust";
  const initialConfig = FRAMING_CONFIGS.bust;

  const currentCamPos = initialConfig.position.clone();
  const currentCamTarget = initialConfig.target.clone();
  const goalCamPos = initialConfig.position.clone();
  const goalCamTarget = initialConfig.target.clone();
  let goalFov = initialConfig.fov;

  const camera = new THREE.PerspectiveCamera(
    initialConfig.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    20,
  );
  camera.position.copy(currentCamPos);
  camera.lookAt(currentCamTarget);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
  directionalLight.position.set(1.2, 2.0, 1.6);
  scene.add(directionalLight);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  const frameCallbacks: FrameCallback[] = [];
  const clock = new THREE.Clock();
  let frameHandle = 0;

  const resize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", resize);

  const setFraming = (preset: FramingPreset, instant = false): void => {
    const config = FRAMING_CONFIGS[preset];
    if (!config) return;
    activePreset = preset;
    goalCamPos.copy(config.position);
    goalCamTarget.copy(config.target);
    goalFov = config.fov;

    if (instant) {
      currentCamPos.copy(goalCamPos);
      currentCamTarget.copy(goalCamTarget);
      camera.fov = goalFov;
      camera.updateProjectionMatrix();
      camera.position.copy(currentCamPos);
      camera.lookAt(currentCamTarget);
    }
  };

  const tick = (): void => {
    const delta = Math.min(clock.getDelta(), MAX_DELTA_SECONDS);

    // Smooth cinematic camera interpolation
    const lerpRate = 1 - Math.exp(-CAMERA_TRANSITION_SPEED * delta);
    currentCamPos.lerp(goalCamPos, lerpRate);
    currentCamTarget.lerp(goalCamTarget, lerpRate);

    if (Math.abs(camera.fov - goalFov) > 0.05) {
      camera.fov = THREE.MathUtils.lerp(camera.fov, goalFov, lerpRate);
      camera.updateProjectionMatrix();
    }

    camera.position.copy(currentCamPos);
    camera.lookAt(currentCamTarget);

    for (const callback of frameCallbacks) {
      callback(delta, clock.elapsedTime);
    }
    renderer.render(scene, camera);
    frameHandle = requestAnimationFrame(tick);
  };
  frameHandle = requestAnimationFrame(tick);

  return {
    scene,
    camera,
    renderer,
    addFrameCallback(callback: FrameCallback): void {
      frameCallbacks.push(callback);
    },
    setFraming,
    getZoomDistance(): number {
      return goalCamPos.distanceTo(goalCamTarget);
    },
    setZoomDistance(distance: number, instant = false): void {
      if (!Number.isFinite(distance) || distance < 0.35 || distance > 10) return;
      const offset = goalCamPos.clone().sub(goalCamTarget).setLength(distance);
      goalCamPos.copy(goalCamTarget).add(offset);
      if (instant) {
        currentCamPos.copy(goalCamPos);
        camera.position.copy(currentCamPos);
        camera.lookAt(currentCamTarget);
      }
    },
    zoomBy(factor: number): void {
      if (!Number.isFinite(factor) || factor <= 0) return;
      const offset = goalCamPos.clone().sub(goalCamTarget);
      const distance = THREE.MathUtils.clamp(offset.length() * factor, 0.35, 10);
      goalCamPos.copy(goalCamTarget).add(offset.setLength(distance));
    },
    getFraming(): FramingPreset {
      return activePreset;
    },
    dispose(): void {
      cancelAnimationFrame(frameHandle);
      window.removeEventListener("resize", resize);
      renderer.dispose();
    },
  };
}
