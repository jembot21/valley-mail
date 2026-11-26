/**
 * Valley Mail hand-in runner. Copies the adjacent game/ and screenshots/ trees
 * and writes the canonical make.fun dossier using only the Node standard library.
 * Structured into sequential phases: resolve roots, validate paths, perform hand-in.
 * Run: node main.ts
 * Or: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
 * Exports: none. Output defaults to /output; input paths never depend on the cwd.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const limits = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

interface HandInRoots {
  inputRoot: string;
  outputRoot: string;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

// Resolve existing symlink ancestors too, so an output alias cannot erase input.
function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(physicalPath(parent), relative(parent, path));
  }
}

function copyTree(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isFile()) {
    copyFileSync(source, destination);
  } else if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    // Code-unit sorting is independent of filesystem enumeration and locale.
    for (const name of readdirSync(source).sort()) {
      copyTree(join(source, name), join(destination, name));
    }
  } else {
    throw new Error('Only plain files and directories can be copied: ' + source);
  }
}

/** Phase 1: resolve physical input root and output root safely. */
function resolveRoots(): HandInRoots {
  const outputRoot = physicalPath(resolve(process.env.MAKEFUN_OUTPUT_DIR || '/output'));
  const inputRoot = realpathSync(sourceRoot);
  return { inputRoot, outputRoot };
}

/** Phase 2: validate that output location does not overlap source trees. */
function validateOutputLocation(inputRoot: string, outputRoot: string): void {
  for (const name of ['game', 'screenshots']) {
    const input = join(inputRoot, name);
    const output = join(outputRoot, name);
    if (isInside(input, outputRoot) || isInside(input, output) || isInside(output, input)) {
      throw new Error('Output must not overlap the source game/ or screenshots/ directories.');
    }
  }
}

/** Phase 3: perform the hand-in with pre-flight check, tree copies, and canonical dossier. */
function performHandIn(outputRoot: string): void {
  // Fail before changing prior output if captures are missing or limits are exceeded.
  buildDossier(sourceRoot, limits);
  mkdirSync(outputRoot, { recursive: true });
  for (const name of ['game', 'screenshots']) {
    const destination = join(outputRoot, name);
    rmSync(destination, { recursive: true, force: true });
    copyTree(join(sourceRoot, name), destination);
  }
  writeFileSync(join(outputRoot, 'dossier.json'), buildDossier(outputRoot, limits));
}

/** Phase 4: entry runner orchestrating phases in order with exact error reporting. */
function main(): void {
  try {
    const { inputRoot, outputRoot } = resolveRoots();
    validateOutputLocation(inputRoot, outputRoot);
    performHandIn(outputRoot);
    console.log('Hand-in written to ' + outputRoot);
  } catch (error) {
    console.error('Valley Mail hand-in: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

main();
