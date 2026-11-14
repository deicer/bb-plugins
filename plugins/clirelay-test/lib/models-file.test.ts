import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectModel, deleteProvider, disconnectModel, listProviders,
  readModelsFile, resolveModelsPath, updateModel, upsertProvider, writeModelsFile, type ModelsFile,
} from "./models-file";

const FIXTURE = {
  providers: {
    "router-test": {
      baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key",
      custom: { keep: true },
      models: [{ id: "m1", contextWindow: 1000, compat: { supportsStore: false } }],
    },
  },
  topLevel: true,
};

async function fixture(): Promise<{ path: string; file: ModelsFile }> {
  const dir = await mkdtemp(join(tmpdir(), "api-models-"));
  const path = join(dir, "models.json");
  await writeFile(path, JSON.stringify(FIXTURE));
  return { path, file: await readModelsFile(path) };
}

describe("resolveModelsPath", () => {
  it("env важнее настройки и дефолта", () => {
    expect(resolveModelsPath({ PI_MODELS_PATH: "/tmp/env.json" }, "/tmp/cfg.json", "/home/u")).toBe("/tmp/env.json");
  });
  it("настройка важнее дефолта, пробелы тримятся", () => {
    expect(resolveModelsPath({}, " /tmp/cfg.json ", "/home/u")).toBe("/tmp/cfg.json");
  });
  it("дефолт ~/.pi/agent/models.json", () => {
    expect(resolveModelsPath({}, "", "/home/u")).toBe("/home/u/.pi/agent/models.json");
    expect(resolveModelsPath({}, undefined, "/home/u")).toBe("/home/u/.pi/agent/models.json");
  });
});

describe("readModelsFile", () => {
  it("нет файла → пустой providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-models-"));
    expect(await readModelsFile(join(dir, "missing.json"))).toEqual({ providers: {} });
  });
  it("битый JSON → ошибка", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-models-"));
    const path = join(dir, "models.json");
    await writeFile(path, "{oops");
    await expect(readModelsFile(path)).rejects.toThrow(/повреждён/);
  });
});

describe("writeModelsFile", () => {
  it("атомарная запись + .bak с прежним содержимым", async () => {
    const { path, file } = await fixture();
    file.providers["router-test"]!.baseUrl = "http://localhost:4011/v1";
    await writeModelsFile(path, file);
    expect(JSON.parse(await readFile(path, "utf8")).providers["router-test"].baseUrl).toBe("http://localhost:4011/v1");
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8")).providers["router-test"].baseUrl).toBe("http://localhost:4010/v1");
  });
});

describe("мутации", () => {
  it("upsert сохраняет неизвестные поля и ключ при пустом apiKey", async () => {
    const { file } = await fixture();
    upsertProvider(file, { id: "router-test", baseUrl: "http://localhost:4011/v1", api: "openai-completions" });
    const entry = file.providers["router-test"]!;
    expect(entry.apiKey).toBe("test-key");
    expect(entry.custom).toEqual({ keep: true });
    expect(file.topLevel).toBe(true);
  });
  it("connect пишет только id, повтор → false", async () => {
    const { file } = await fixture();
    expect(connectModel(file, "router-test", "m2")).toBe(true);
    expect(connectModel(file, "router-test", "m2")).toBe(false);
    expect(file.providers["router-test"]!.models).toEqual([
      { id: "m1", contextWindow: 1000, compat: { supportsStore: false } }, { id: "m2" },
    ]);
  });
  it("disconnect удаляет, отсутствующая → false", async () => {
    const { file } = await fixture();
    expect(disconnectModel(file, "router-test", "m1")).toBe(true);
    expect(disconnectModel(file, "router-test", "m1")).toBe(false);
  });
  it("update: null удаляет поле, неизвестные поля модели целы", async () => {
    const { file } = await fixture();
    const model = updateModel(file, "router-test", "m1", { contextWindow: null, reasoning: true });
    expect(model).toEqual({ id: "m1", compat: { supportsStore: false }, reasoning: true });
  });
  it("deleteProvider", async () => {
    const { file } = await fixture();
    expect(deleteProvider(file, "router-test")).toBe(true);
    expect(deleteProvider(file, "router-test")).toBe(false);
  });
  it("listProviders не отдаёт apiKey и headers", async () => {
    const { file } = await fixture();
    file.providers["router-test"]!.headers = { "X-Secret": "test-key" };
    const [view] = listProviders(file);
    expect(view).toEqual({
      id: "router-test", name: undefined, baseUrl: "http://localhost:4010/v1",
      api: "openai-completions", apiKeySet: true,
      models: [{ id: "m1", contextWindow: 1000, compat: { supportsStore: false } }],
      disabled: [],
    });
    expect(JSON.stringify(view)).not.toContain("test-key");
  });
});
