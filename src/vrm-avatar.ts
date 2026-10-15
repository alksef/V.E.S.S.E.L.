import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";

/** Loads a VRM model into a Three.js scene and ticks VRM internal state every frame. */
export class VrmAvatar {
  private vrm: VRM | null = null;

  constructor(private readonly scene: THREE.Scene) {}

  /** The underlying VRM instance, or null until a model is loaded. */
  get raw(): VRM | null {
    return this.vrm;
  }

  async loadModel(url: string): Promise<VRM> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      VRMUtils.deepDispose(gltf.scene);
      throw new Error(`No VRM payload found in ${url}`);
    }

    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    // VRM 0.x models face -Z; normalize every model to the VRM 1.0 +Z convention.
    VRMUtils.rotateVRM0(vrm);

    // Procedural bones and springbones can push geometry outside its bounds,
    // so the avatar must never be frustum-culled mid-animation.
    vrm.scene.traverse((object) => {
      object.frustumCulled = false;
    });

    this.scene.add(vrm.scene);
    this.vrm = vrm;
    return vrm;
  }

  getBone(boneName: VRMHumanBoneName): THREE.Object3D | null {
    return this.vrm?.humanoid.getNormalizedBoneNode(boneName) ?? null;
  }

  update(delta: number): void {
    // Propagates normalized-bone rotations, springbones, lookAt and expression weights.
    this.vrm?.update(delta);
  }

  dispose(): void {
    if (!this.vrm) return;
    VRMUtils.deepDispose(this.vrm.scene);
    this.scene.remove(this.vrm.scene);
    this.vrm = null;
  }
}
