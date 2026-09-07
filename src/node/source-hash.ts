import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
/** Content identity for a git worktree, including untracked nonignored inputs. */
export function sourceHash(
  rootDir = process.cwd(),
  excludedPaths: readonly string[] = [],
): string | undefined {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: rootDir, encoding: "utf8" },
  );
  if (listed.status !== 0) return undefined;
  const exclusions = [
    ".proof/traces",
    ".proof/mutations",
    ".proof/schema.json",
    ".proof/capabilities.json",
    ".proof/drift.json",
    ".proof/mutation-recovery.json",
    ...excludedPaths,
  ].map((p) => path.resolve(rootDir, p));
  const digest = crypto.createHash("sha256");
  for (const file of [
    ...new Set(listed.stdout.split("\0").filter(Boolean)),
  ].sort()) {
    const full = path.join(rootDir, file);
    if (exclusions.some((p) => full === p || full.startsWith(p + path.sep)))
      continue;
    digest.update(file).update("\0");
    if (!fs.existsSync(full)) {
      digest.update("<deleted>");
      continue;
    }
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) digest.update(fs.readlinkSync(full));
    else if (stat.isFile())
      digest.update(String(stat.mode & 0o777)).update(fs.readFileSync(full));
    digest.update("\0");
  }
  return digest.digest("hex");
}
