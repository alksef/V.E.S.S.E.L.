import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("writes rapid zoom changes in order and recovers after a storage error", async () => {
  let finishFirst!: () => void;
  const invoke = vi.fn()
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
  const { saveView } = await import("../src/config-store");
  const first = saveView({ framing: "bust", distance: 1 });
  const second = saveView({ framing: "bust", distance: 2 });
  const failed = expect(second).rejects.toThrow("disk full");
  const third = saveView({ framing: "full_body", distance: 3 });
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
  finishFirst();
  await first;
  await failed;
  await third;
  expect(invoke.mock.calls.map((call) => call[1].view.distance)).toEqual([1, 2, 3]);
});

it("restores model bytes from native storage and saves a replacement", async () => {
  const invoke = vi.fn(async (command: string) => {
    if (command === "load_config") return { model: { name: "avatar.vrm", file: "saved.vrm" } };
    if (command === "read_model") return new Uint8Array([0, 127, 255]).buffer;
  });
  vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
  const { readSavedModel, saveModel } = await import("../src/model-store");
  const model = await readSavedModel();
  expect(model?.name).toBe("avatar.vrm");
  expect(Array.from(new Uint8Array(await model!.data.arrayBuffer()))).toEqual([0, 127, 255]);
  await saveModel({ name: "новая.vrm", data: new Blob([new Uint8Array([1, 2, 255])]) });
  expect(invoke).toHaveBeenLastCalledWith("save_model", { name: "новая.vrm", data: [1, 2, 255] });
});
