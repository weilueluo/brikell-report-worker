import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { __test_only } from "../../src/agent/managed/runner";

function withOutputMirrorDir<T>(mirrorDir: string, fn: () => T): T {
  const previous = process.env.MANAGED_AGENT_OUTPUT_MIRROR_DIR;
  process.env.MANAGED_AGENT_OUTPUT_MIRROR_DIR = mirrorDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.MANAGED_AGENT_OUTPUT_MIRROR_DIR;
    else process.env.MANAGED_AGENT_OUTPUT_MIRROR_DIR = previous;
  }
}

test("safeOutputPathSegment keeps safe names and replaces unsafe or traversal-only names", () => {
  assert.equal(__test_only.safeOutputPathSegment("job-123_report.json"), "job-123_report.json");
  assert.equal(__test_only.safeOutputPathSegment("job with spaces"), "job_with_spaces");
  assert.equal(__test_only.safeOutputPathSegment("."), "output");
  assert.equal(__test_only.safeOutputPathSegment(".."), "output");
  assert.equal(__test_only.safeOutputPathSegment("///"), "output");
  assert.equal(__test_only.safeOutputPathSegment("///", "fallback"), "fallback");
});

test("localManagedOutputPath only maps files under the managed output root", async () => {
  const mirrorDir = await mkdtemp(join(tmpdir(), "brikell-output-mirror-"));
  try {
    withOutputMirrorDir(mirrorDir, () => {
      assert.equal(__test_only.localManagedOutputPath("/mnt/session/work/report.md"), undefined);
      assert.equal(__test_only.localManagedOutputPath("/tmp/session/outputs/job/report.md"), undefined);

      const localPath = __test_only.localManagedOutputPath("/mnt/session/outputs/job-1/report.md");
      assert.equal(localPath, resolve(process.cwd(), mirrorDir, "job-1", "report.md"));
    });
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

test("localManagedOutputPath sanitizes every output path segment before mirroring", async () => {
  const mirrorDir = await mkdtemp(join(tmpdir(), "brikell-output-mirror-"));
  try {
    withOutputMirrorDir(mirrorDir, () => {
      const localPath = __test_only.localManagedOutputPath("/mnt/session/outputs/.././job with spaces/report?.md");
      assert.equal(localPath, resolve(process.cwd(), mirrorDir, "output-1", "output-2", "job_with_spaces", "report_.md"));
    });
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

test("getManagedOutputOperation captures write operations only for managed outputs", async () => {
  const mirrorDir = await mkdtemp(join(tmpdir(), "brikell-output-mirror-"));
  try {
    withOutputMirrorDir(mirrorDir, () => {
      const operation = __test_only.getManagedOutputOperation({
        name: "write",
        input: { file_path: "/mnt/session/outputs/job-2/report.md", content: "# Report" },
      });

      assert.deepEqual(operation, {
        kind: "write",
        managedPath: "/mnt/session/outputs/job-2/report.md",
        localPath: resolve(process.cwd(), mirrorDir, "job-2", "report.md"),
        content: "# Report",
      });

      assert.equal(
        __test_only.getManagedOutputOperation({
          name: "write",
          input: { file_path: "/mnt/session/work/report.md", content: "# Report" },
        }),
        undefined,
      );
      assert.equal(
        __test_only.getManagedOutputOperation({
          name: "write",
          input: { file_path: "/mnt/session/outputs/job-2/report.md", content: 42 },
        }),
        undefined,
      );
    });
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

test("getManagedOutputOperation captures edit operations with explicit replacement strings", async () => {
  const mirrorDir = await mkdtemp(join(tmpdir(), "brikell-output-mirror-"));
  try {
    withOutputMirrorDir(mirrorDir, () => {
      const operation = __test_only.getManagedOutputOperation({
        name: "edit",
        input: {
          file_path: "/mnt/session/outputs/job-3/report.md",
          old_string: "Draft",
          new_string: "Final",
        },
      });

      assert.deepEqual(operation, {
        kind: "edit",
        managedPath: "/mnt/session/outputs/job-3/report.md",
        localPath: resolve(process.cwd(), mirrorDir, "job-3", "report.md"),
        oldString: "Draft",
        newString: "Final",
      });

      assert.equal(
        __test_only.getManagedOutputOperation({
          name: "edit",
          input: {
            file_path: "/mnt/session/outputs/job-3/report.md",
            old_string: "Draft",
          },
        }),
        undefined,
      );
    });
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

test("applyManagedOutputOperation records writes and applies edits to tracked snapshots", () => {
  const snapshots = new Map();
  const write = {
    kind: "write" as const,
    managedPath: "/mnt/session/outputs/job-4/report.md",
    localPath: resolve(process.cwd(), ".mirror", "job-4", "report.md"),
    content: "Title\nDraft body\n",
  };

  const writeSnapshot = __test_only.applyManagedOutputOperation(write, snapshots);
  assert.deepEqual(writeSnapshot, write);
  assert.ok(writeSnapshot);
  snapshots.set(writeSnapshot.managedPath, writeSnapshot);

  const edited = __test_only.applyManagedOutputOperation(
    {
      kind: "edit",
      managedPath: write.managedPath,
      localPath: write.localPath,
      oldString: "Draft",
      newString: "Final",
    },
    snapshots,
  );

  assert.deepEqual(edited, {
    managedPath: write.managedPath,
    localPath: write.localPath,
    content: "Title\nFinal body\n",
  });
});

test("applyManagedOutputOperation skips edits without a prior write or matching old text", () => {
  const snapshots = new Map();
  const edit = {
    kind: "edit" as const,
    managedPath: "/mnt/session/outputs/job-5/report.md",
    localPath: resolve(process.cwd(), ".mirror", "job-5", "report.md"),
    oldString: "missing",
    newString: "replacement",
  };

  assert.equal(__test_only.applyManagedOutputOperation(edit, snapshots), undefined);

  snapshots.set(edit.managedPath, {
    managedPath: edit.managedPath,
    localPath: edit.localPath,
    content: "No matching text",
  });
  assert.equal(__test_only.applyManagedOutputOperation(edit, snapshots), undefined);
});

test("mirrorManagedOutput writes the mirrored file content", async () => {
  const mirrorDir = await mkdtemp(join(tmpdir(), "brikell-output-mirror-"));
  try {
    const localPath = join(mirrorDir, "job-6", "report.md");
    __test_only.mirrorManagedOutput({
      managedPath: "/mnt/session/outputs/job-6/report.md",
      localPath,
      content: "# Final report\n",
    });

    assert.equal(await readFile(localPath, "utf8"), "# Final report\n");
  } finally {
    await rm(mirrorDir, { recursive: true, force: true });
  }
});
