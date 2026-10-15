import { afterEach, expect, it, vi } from "vitest";
import { createVrmScene } from "../src/vrm-scene";

vi.mock("three", async (importOriginal) => {
  const three = await importOriginal<typeof import("three")>();
  return {
    ...three,
    WebGLRenderer: class {
      setClearColor() {}
      setPixelRatio() {}
      setSize() {}
      dispose() {}
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

it("restores the target zoom even when saved during a camera transition", () => {
  vi.stubGlobal("window", {
    innerWidth: 500, innerHeight: 700, devicePixelRatio: 1,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const original = createVrmScene({} as HTMLCanvasElement);
  original.setFraming("full_body");
  original.zoomBy(1 / 1.2);
  original.zoomBy(1 / 1.2);
  const distance = original.getZoomDistance();

  const restored = createVrmScene({} as HTMLCanvasElement);
  restored.setFraming(original.getFraming(), true);
  restored.setZoomDistance(distance, true);
  expect(restored.camera.position.distanceTo(original.camera.position)).toBeGreaterThan(1);
  expect(restored.getZoomDistance()).toBeCloseTo(distance);
  expect(restored.camera.position.y).toBeCloseTo(0.5 + 0.05 / 1.2 ** 2);
  expect(restored.camera.position.z).toBeCloseTo(4.8 / 1.2 ** 2);

  restored.zoomBy(100);
  expect(restored.getZoomDistance()).toBeCloseTo(10);
  restored.zoomBy(0.00001);
  expect(restored.getZoomDistance()).toBeCloseTo(0.35);
  restored.setZoomDistance(NaN);
  expect(restored.getZoomDistance()).toBeCloseTo(0.35);
  original.dispose();
  restored.dispose();
});
