import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ThemePatternHeader {
  raw: string;
  title?: string;
  slug?: string;
}

export interface ThemeMarkupFile {
  /** Absolute path used for reading and writing. */
  path: string;
  /** POSIX path relative to the theme root for stable reports. */
  file: string;
  kind: 'template' | 'part' | 'pattern';
  content: string;
  markup: string;
  header?: ThemePatternHeader;
  skipReason?: 'pattern-php-body' | 'theme-unsafe-target';
}

/** Return whether a directory has the top-level files WordPress uses to identify theme content. */
export async function isThemeDirectory(directory: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  return entries.some((entry) =>
    (entry.name === 'theme.json' && (entry.isFile() || entry.isSymbolicLink()))
    || (['templates', 'parts', 'patterns'].includes(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())),
  );
}

/**
 * List the authored files WordPress discovers for block templates, parts and patterns.
 * Template/part HTML and pattern PHP are recursive, case-insensitive extension matches.
 */
export async function discoverThemeMarkupFiles(directory: string): Promise<ThemeMarkupFile[]> {
  const roots = [
    { directory: 'templates', kind: 'template' as const, extension: '.html' },
    { directory: 'parts', kind: 'part' as const, extension: '.html' },
    { directory: 'patterns', kind: 'pattern' as const, extension: '.php' },
  ];
  const files: ThemeMarkupFile[] = [];

  for (const root of roots) {
    const rootPath = path.join(directory, root.directory);
    let rootStats;
    try {
      rootStats = await lstat(rootPath);
    } catch {
      continue;
    }
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      files.push({
        path: rootPath,
        file: `${root.directory}/`,
        kind: root.kind,
        content: '',
        markup: '',
        skipReason: 'theme-unsafe-target',
      });
      continue;
    }

    for (const filePath of await recursiveFiles(rootPath, root.extension, root.kind !== 'pattern', root.kind === 'pattern')) {
      const relativePath = path.relative(directory, filePath).split(path.sep).join('/');
      const targetStats = await lstat(filePath);
      if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
        files.push({ path: filePath, file: relativePath, kind: root.kind, content: '', markup: '', skipReason: 'theme-unsafe-target' });
        continue;
      }
      const content = await readFile(filePath, 'utf8');
      if (root.kind !== 'pattern') {
        files.push({ path: filePath, file: relativePath, kind: root.kind, content, markup: content });
        continue;
      }

      const { header, markup } = splitPatternHeader(content);
      files.push({
        path: filePath,
        file: relativePath,
        kind: root.kind,
        content,
        markup,
        ...(header ? { header } : {}),
        ...(containsPhp(markup) ? { skipReason: 'pattern-php-body' as const } : {}),
      });
    }
  }

  return files.sort((left, right) => left.file.localeCompare(right.file));
}

async function recursiveFiles(
  directory: string,
  extension: string,
  caseInsensitive: boolean,
  skipWordPressDirectories: boolean,
): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    if (skipWordPressDirectories
      && (entry.name.startsWith('.') || ['CVS', 'node_modules', 'vendor', 'bower_components'].includes(entry.name))) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await recursiveFiles(filePath, extension, caseInsensitive, skipWordPressDirectories));
    } else if ((entry.isFile() || entry.isSymbolicLink())
      && (caseInsensitive ? path.extname(entry.name).toLowerCase() === extension : path.extname(entry.name) === extension)) {
      files.push(filePath);
    }
  }
  return files;
}

function splitPatternHeader(content: string): { header?: ThemePatternHeader; markup: string } {
  const match = /^((?:\uFEFF)?[\t \r\n]*<\?php[\t \r\n]*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\r|\n|$)|\#[^\r\n]*(?:\r\n|\r|\n|$))[\t \r\n]*)*\?>[\t ]*(?:\r\n|\r|\n)?)/.exec(content);
  if (!match) return { markup: content };

  const raw = match[1]!;
  const comment = /\/\*[\s\S]*?\*\//.exec(raw)?.[0] ?? '';
  const field = (name: 'Title' | 'Slug'): string | undefined => {
    const value = new RegExp(`^[\\t ]*\\*?[\\t ]*${name}:[\\t ]*(.+?)[\\t ]*$`, 'im').exec(comment)?.[1];
    return value?.trim();
  };
  return { header: { raw, ...(field('Title') ? { title: field('Title') } : {}), ...(field('Slug') ? { slug: field('Slug') } : {}) }, markup: content.slice(raw.length) };
}

function containsPhp(markup: string): boolean {
  return /<\?(?:php\b|=)?/i.test(markup);
}
