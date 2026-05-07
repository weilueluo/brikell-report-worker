import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  __test_only,
  managedSkillUploadDisplayTitle,
} from "../../src/agent/managed/runner";

const testTmpRoot = join(process.cwd(), ".test-artifacts", "skill-upload");

async function makeTestDir(): Promise<string> {
  await mkdir(testTmpRoot, { recursive: true });
  return mkdtemp(join(testTmpRoot, "case-"));
}

async function cleanupTestDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await rm(testTmpRoot, { recursive: true, force: true });
}

function missingSkillDirectory(): string {
  return join(process.cwd(), ".test-artifacts", "missing-skill-directory");
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function withCleanSkillEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  return withEnv(
    {
      SQL_SKILL_ID: undefined,
      SQL_SKILL_VERSION: undefined,
      MANAGED_AGENT_REQUIRE_CONFIGURED_SKILLS: undefined,
      VERCEL: undefined,
      ...overrides,
    },
    async () => {
      __test_only.resetManagedSkillEnvironmentForTests();
      try {
        return await fn();
      } finally {
        __test_only.resetManagedSkillEnvironmentForTests();
      }
    },
  );
}

function withSkillRegistryPath<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  return withCleanSkillEnv({ MANAGED_AGENT_SKILL_REGISTRY_FILE: registryPath }, fn);
}

test("managedSkillUploadDisplayTitle includes a deterministic content hash", () => {
  const title = managedSkillUploadDisplayTitle(
    "SQL",
    "c3d438e79f4318aa61175f9d268cde1d5f8f855afbad0be09eec36056e25738f",
  );

  assert.equal(title, "SQL c3d438e79f43");
});

test("managedSkillUploadDisplayTitle stays within the platform title limit", () => {
  const hash = "c3d438e79f4318aa61175f9d268cde1d5f8f855afbad0be09eec36056e25738f";

  const title = managedSkillUploadDisplayTitle("A very long skill title that would otherwise exceed the platform display title length", hash);

  assert.equal(title.length <= 64, true);
  assert.match(title, / c3d438e79f43$/);
});

test("prepareManagedSkills uploads uncached skills with SDK retries disabled", async () => {
  const dir = await makeTestDir();
  try {
    const skillDir = join(dir, "sql");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: sql\ndisplay_title: SQL\n---\n# SQL\n",
      "utf8",
    );
    await writeFile(join(skillDir, "README.txt"), "provider guidance\n", "utf8");

    const registryPath = join(dir, "registry.json");
    const calls: Array<{ params: { display_title?: string; files?: unknown[] }; options?: { maxRetries?: number } }> = [];
    let listCount = 0;
    const beta = {
      skills: {
        async *list() {
          listCount++;
        },
        async create(params: { display_title?: string; files?: unknown[] }, options?: { maxRetries?: number }) {
          calls.push({ params, options });
          return { id: "skill_uploaded", latest_version: "version_1" };
        },
      },
    };

    const result = await withSkillRegistryPath(registryPath, async () => {
      const managedSkills = await __test_only.prepareManagedSkills(beta, [
        {
          key: "sql",
          displayTitle: "SQL",
          directoryPath: skillDir,
          skillIdEnv: "SQL_SKILL_ID",
          versionEnv: "SQL_SKILL_VERSION",
        },
      ]);
      return {
        managedSkills,
        skillId: process.env.SQL_SKILL_ID,
        version: process.env.SQL_SKILL_VERSION,
      };
    });

    assert.deepEqual(result.managedSkills, [{ type: "custom", skill_id: "skill_uploaded", version: "version_1" }]);
    assert.equal(result.skillId, "skill_uploaded");
    assert.equal(result.version, "version_1");
    assert.equal(calls.length, 1);
    assert.equal(listCount, 1);
    assert.match(calls[0]!.params.display_title ?? "", /^SQL [a-f0-9]{12}$/);
    assert.ok((calls[0]!.params.files?.length ?? 0) >= 2);
    assert.deepEqual(calls[0]!.options, { maxRetries: 0 });

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      sql?: { skillId?: string; version?: string; hash?: string };
    };
    assert.equal(registry.sql?.skillId, "skill_uploaded");
    assert.equal(registry.sql?.version, "version_1");
    assert.equal(typeof registry.sql?.hash, "string");
  } finally {
    await cleanupTestDir(dir);
  }
});

test("prepareManagedSkills uses configured skill IDs without reading files or uploading", async () => {
  let createCalled = false;
  const beta = {
    skills: {
      async create() {
        createCalled = true;
        throw new Error("skills.create should not run for configured skills");
      },
    },
  };

  const result = await withCleanSkillEnv(
    {
      SQL_SKILL_ID: "skill_configured",
      SQL_SKILL_VERSION: "version_configured",
      MANAGED_AGENT_REQUIRE_CONFIGURED_SKILLS: "on",
    },
    async () => {
      const managedSkills = await __test_only.prepareManagedSkills(beta, [
        {
          key: "sql",
          displayTitle: "SQL",
          directoryPath: missingSkillDirectory(),
          skillIdEnv: "SQL_SKILL_ID",
          versionEnv: "SQL_SKILL_VERSION",
        },
      ]);
      return {
        managedSkills,
        skillId: process.env.SQL_SKILL_ID,
        version: process.env.SQL_SKILL_VERSION,
      };
    },
  );

  assert.deepEqual(result.managedSkills, [{ type: "custom", skill_id: "skill_configured", version: "version_configured" }]);
  assert.equal(result.skillId, "skill_configured");
  assert.equal(result.version, "version_configured");
  assert.equal(createCalled, false);
});

test("prepareManagedSkills requires configured skill IDs only when explicitly requested", async () => {
  let createCalled = false;
  const beta = {
    skills: {
      async create() {
        createCalled = true;
        throw new Error("skills.create should not run when configured IDs are required");
      },
    },
  };

  await assert.rejects(
    () =>
      withCleanSkillEnv(
        {
          SQL_SKILL_ID: undefined,
          SQL_SKILL_VERSION: undefined,
          MANAGED_AGENT_REQUIRE_CONFIGURED_SKILLS: "on",
        },
        () =>
          __test_only.prepareManagedSkills(beta, [
            {
              key: "sql",
              displayTitle: "SQL",
              directoryPath: missingSkillDirectory(),
              skillIdEnv: "SQL_SKILL_ID",
              versionEnv: "SQL_SKILL_VERSION",
            },
          ]),
      ),
    /runtime skill upload is disabled.*sql: SQL_SKILL_ID/,
  );
  assert.equal(createCalled, false);
});

test("prepareManagedSkills bootstraps skills on Vercel when deployment env vars are empty", async () => {
  const dir = await makeTestDir();
  try {
    const skillDir = join(dir, "sql");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: sql\ndisplay_title: SQL\n---\n# SQL\n",
      "utf8",
    );

    let createCount = 0;
    const beta = {
      skills: {
        async *list() {
          return;
        },
        async create() {
          createCount++;
          return { id: "skill_bootstrapped", latest_version: "version_bootstrapped" };
        },
      },
    };

    const result = await withCleanSkillEnv(
      {
        VERCEL: "1",
        SQL_SKILL_ID: "",
        SQL_SKILL_VERSION: "",
        MANAGED_AGENT_SKILL_REGISTRY_FILE: join(dir, "registry.json"),
      },
      async () => {
        const managedSkills = await __test_only.prepareManagedSkills(beta, [
          {
            key: "sql",
            displayTitle: "SQL",
            directoryPath: skillDir,
            skillIdEnv: "SQL_SKILL_ID",
            versionEnv: "SQL_SKILL_VERSION",
          },
        ]);
        return {
          managedSkills,
          skillId: process.env.SQL_SKILL_ID,
          version: process.env.SQL_SKILL_VERSION,
        };
      },
    );

    assert.deepEqual(result.managedSkills, [{ type: "custom", skill_id: "skill_bootstrapped", version: "version_bootstrapped" }]);
    assert.equal(result.skillId, "skill_bootstrapped");
    assert.equal(result.version, "version_bootstrapped");
    assert.equal(createCount, 1);
  } finally {
    await cleanupTestDir(dir);
  }
});

test("prepareManagedSkills recovers concurrent create collisions by re-reading uploaded skills", async () => {
  const dir = await makeTestDir();
  try {
    const skillDir = join(dir, "sql");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: sql\ndisplay_title: SQL\n---\n# SQL\n",
      "utf8",
    );

    let createDisplayTitle: string | undefined;
    let listCount = 0;
    const beta = {
      skills: {
        async *list() {
          listCount++;
          if (listCount > 1 && createDisplayTitle) {
            yield {
              id: "skill_existing_after_collision",
              display_title: createDisplayTitle,
              latest_version: "version_existing_after_collision",
            };
          }
        },
        async create(params: { display_title?: string }) {
          createDisplayTitle = params.display_title;
          throw new Error(`Skill cannot reuse an existing display_title: ${createDisplayTitle}`);
        },
      },
    };

    const result = await withSkillRegistryPath(join(dir, "registry.json"), async () => {
      const managedSkills = await __test_only.prepareManagedSkills(beta, [
        {
          key: "sql",
          displayTitle: "SQL",
          directoryPath: skillDir,
          skillIdEnv: "SQL_SKILL_ID",
          versionEnv: "SQL_SKILL_VERSION",
        },
      ]);
      return {
        managedSkills,
        skillId: process.env.SQL_SKILL_ID,
      };
    });

    assert.deepEqual(result.managedSkills, [
      { type: "custom", skill_id: "skill_existing_after_collision", version: "version_existing_after_collision" },
    ]);
    assert.equal(result.skillId, "skill_existing_after_collision");
    assert.equal(listCount, 2);
  } finally {
    await cleanupTestDir(dir);
  }
});

test("requiresConfiguredManagedSkillIds is controlled by the explicit require flag", async () => {
  await withEnv({ VERCEL: undefined, MANAGED_AGENT_REQUIRE_CONFIGURED_SKILLS: undefined }, async () => {
    assert.equal(__test_only.requiresConfiguredManagedSkillIds(), false);
  });
  await withEnv({ VERCEL: "1", MANAGED_AGENT_REQUIRE_CONFIGURED_SKILLS: undefined }, async () => {
    assert.equal(__test_only.requiresConfiguredManagedSkillIds(), false);
  });
  await withEnv({ VERCEL: undefined, MANAGED_AGENT_REQUIRE_CONFIGURED_SKILLS: "on" }, async () => {
    assert.equal(__test_only.requiresConfiguredManagedSkillIds(), true);
  });
});

test("prepareManagedSkills reuses cached skill registry entries for unchanged files", async () => {
  const dir = await makeTestDir();
  try {
    const skillDir = join(dir, "sql");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: sql\ndisplay_title: SQL\n---\n# SQL\n",
      "utf8",
    );

    const registryPath = join(dir, "registry.json");
    let createCount = 0;
    const beta = {
      skills: {
        async *list() {
          return;
        },
        async create() {
          createCount++;
          return { id: "skill_uploaded", latest_version: "version_1" };
        },
      },
    };
    const skills = [
      {
        key: "sql",
        displayTitle: "SQL",
        directoryPath: skillDir,
        skillIdEnv: "SQL_SKILL_ID",
        versionEnv: "SQL_SKILL_VERSION",
      },
    ];

    await withSkillRegistryPath(registryPath, () => __test_only.prepareManagedSkills(beta, skills));
    const second = await withSkillRegistryPath(registryPath, () => __test_only.prepareManagedSkills(beta, skills));

    assert.equal(createCount, 1);
    assert.deepEqual(second, [{ type: "custom", skill_id: "skill_uploaded", version: "version_1" }]);
  } finally {
    await cleanupTestDir(dir);
  }
});
