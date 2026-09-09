import fs from "node:fs";
import path from "node:path";
import { STATE_FILES } from "../config.js";

export interface StateDirInfo {
  path: string;
  exists: boolean;
  files: Record<(typeof STATE_FILES)[number], boolean>;
}

export function checkStateDir(stateDirPath: string): StateDirInfo {
  const exists = fs.existsSync(stateDirPath) && fs.statSync(stateDirPath).isDirectory();

  const files = {} as Record<(typeof STATE_FILES)[number], boolean>;
  for (const fileName of STATE_FILES) {
    files[fileName] = exists && fs.existsSync(path.join(stateDirPath, fileName));
  }

  return { path: stateDirPath, exists, files };
}

// First non-empty, non-heading line of a state file -- used by `status` to surface a
// one-line hint (e.g. the current active task) without parsing markdown structure. Returns
// undefined rather than guessing if the file is missing or has no such line.
export function readFirstContentLine(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        return trimmed;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
