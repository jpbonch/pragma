import { join } from "node:path";
import { access, mkdir, chmod, readdir, rename, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";
import { getWorkspacePaths } from "./db";

export async function ensureConnectorBinary(
  binaryName: string,
  downloadUrl: string,
  workspaceName: string,
): Promise<string> {
  const binDir = getWorkspacePaths(workspaceName).binDir;
  const binPath = join(binDir, binaryName);

  try {
    await access(binPath);
    return binPath;
  } catch {
    // need to download
  }

  await mkdir(binDir, { recursive: true });

  if (downloadUrl.startsWith("npm:")) {
    const pkg = downloadUrl.slice(4);
    const modulesDir = join(binDir, "node_modules");
    execSync(`npm install --prefix "${binDir}" ${pkg}`, { stdio: "pipe" });
    // Try to find the binary in the installed package
    const pkgBinDir = join(modulesDir, ".bin");
    const pkgBinPath = join(pkgBinDir, binaryName);
    try {
      await access(pkgBinPath);
      // Symlink or copy to binDir
      const { symlinkSync } = await import("node:fs");
      try {
        symlinkSync(pkgBinPath, binPath);
      } catch {
        // Already exists or can't symlink — that's fine
      }
    } catch {
      // Binary might be directly in modulesDir — best effort
    }
    return binPath;
  }

  // Download .tar.gz, extract the binary
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const tmpFile = join(binDir, `_download_${binaryName}.tar.gz`);
  const tmpExtractDir = join(binDir, `_extract_${binaryName}`);

  try {
    // Write response to temp file
    const body = response.body;
    if (!body) {
      throw new Error("Empty response body");
    }
    const fileStream = createWriteStream(tmpFile);
    await pipeline(body, fileStream);

    // Extract tar.gz
    await mkdir(tmpExtractDir, { recursive: true });
    execSync(`tar xzf "${tmpFile}" -C "${tmpExtractDir}"`, { stdio: "pipe" });

    // Find the binary in extracted files (search recursively)
    const found = await findBinaryInDir(tmpExtractDir, binaryName);
    if (found) {
      await rename(found, binPath);
      await chmod(binPath, 0o755);
    } else {
      throw new Error(`Binary '${binaryName}' not found in downloaded archive`);
    }
  } finally {
    // Cleanup temp files
    try { await unlink(tmpFile); } catch { /* ignore */ }
    try { execSync(`rm -rf "${tmpExtractDir}"`, { stdio: "pipe" }); } catch { /* ignore */ }
  }

  return binPath;
}

async function findBinaryInDir(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) {
      return full;
    }
    if (entry.isDirectory()) {
      const found = await findBinaryInDir(full, name);
      if (found) return found;
    }
  }
  return null;
}

export function getConnectorBinDir(workspaceName: string): string {
  return getWorkspacePaths(workspaceName).binDir;
}
