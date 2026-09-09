import fs from "node:fs";
import path from "node:path";

export interface CookVideoAppInfo {
  relativePath: string;
  exists: boolean;
  hasPackageJson: boolean;
  hasNextDependency: boolean;
}

export interface CookVideoRepoInfo {
  repoPath: string;
  exists: boolean;
  isDirectory: boolean;
  app: CookVideoAppInfo;
}

// Real, verified checks -- never assumes the app is where we expect without reading the
// filesystem. hasNextDependency actually opens apps/web/package.json and looks for "next"
// in dependencies/devDependencies, rather than trusting the directory name alone.
export function checkCookVideoRepo(repoPath: string, appRelativePath: string): CookVideoRepoInfo {
  let exists = false;
  let isDirectory = false;
  try {
    const stat = fs.statSync(repoPath);
    exists = true;
    isDirectory = stat.isDirectory();
  } catch {
    exists = false;
  }

  const appPath = path.join(repoPath, appRelativePath);
  let appExists = false;
  try {
    appExists = fs.statSync(appPath).isDirectory();
  } catch {
    appExists = false;
  }

  let hasPackageJson = false;
  let hasNextDependency = false;
  if (appExists) {
    const pkgPath = path.join(appPath, "package.json");
    try {
      const raw = fs.readFileSync(pkgPath, "utf8");
      hasPackageJson = true;
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      hasNextDependency = Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
    } catch {
      hasPackageJson = false;
    }
  }

  return {
    repoPath,
    exists,
    isDirectory,
    app: {
      relativePath: appRelativePath,
      exists: appExists,
      hasPackageJson,
      hasNextDependency,
    },
  };
}
