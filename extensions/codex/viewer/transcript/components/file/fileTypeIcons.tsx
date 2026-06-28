import type { IconifyIcon } from '@iconify/types';
import fileTypeAstro from '@iconify/icons-vscode-icons/file-type-astro';
import fileTypeAudio from '@iconify/icons-vscode-icons/file-type-audio';
import fileTypeBabel from '@iconify/icons-vscode-icons/file-type-babel';
import fileTypeBinary from '@iconify/icons-vscode-icons/file-type-binary';
import fileTypeC from '@iconify/icons-vscode-icons/file-type-c';
import fileTypeConfig from '@iconify/icons-vscode-icons/file-type-config';
import fileTypeCpp from '@iconify/icons-vscode-icons/file-type-cpp';
import fileTypeCsharp from '@iconify/icons-vscode-icons/file-type-csharp';
import fileTypeCss from '@iconify/icons-vscode-icons/file-type-css';
import fileTypeDart from '@iconify/icons-vscode-icons/file-type-dartlang';
import fileTypeDocker from '@iconify/icons-vscode-icons/file-type-docker';
import fileTypeDotenv from '@iconify/icons-vscode-icons/file-type-dotenv';
import fileTypeEslint from '@iconify/icons-vscode-icons/file-type-eslint';
import fileTypeExcel from '@iconify/icons-vscode-icons/file-type-excel';
import fileTypeFont from '@iconify/icons-vscode-icons/file-type-font';
import fileTypeGit from '@iconify/icons-vscode-icons/file-type-git';
import fileTypeGo from '@iconify/icons-vscode-icons/file-type-go';
import fileTypeGraphql from '@iconify/icons-vscode-icons/file-type-graphql';
import fileTypeHtml from '@iconify/icons-vscode-icons/file-type-html';
import fileTypeImage from '@iconify/icons-vscode-icons/file-type-image';
import fileTypeJava from '@iconify/icons-vscode-icons/file-type-java';
import fileTypeJest from '@iconify/icons-vscode-icons/file-type-jest';
import fileTypeJs from '@iconify/icons-vscode-icons/file-type-js';
import fileTypeJson from '@iconify/icons-vscode-icons/file-type-json';
import fileTypeKotlin from '@iconify/icons-vscode-icons/file-type-kotlin';
import fileTypeLess from '@iconify/icons-vscode-icons/file-type-less';
import fileTypeLicense from '@iconify/icons-vscode-icons/file-type-license';
import fileTypeLog from '@iconify/icons-vscode-icons/file-type-log';
import fileTypeLua from '@iconify/icons-vscode-icons/file-type-lua';
import fileTypeMarkdown from '@iconify/icons-vscode-icons/file-type-markdown';
import fileTypeMdx from '@iconify/icons-vscode-icons/file-type-mdx';
import fileTypeNpm from '@iconify/icons-vscode-icons/file-type-npm';
import fileTypePdf from '@iconify/icons-vscode-icons/file-type-pdf2';
import fileTypePhp from '@iconify/icons-vscode-icons/file-type-php';
import fileTypePlaywright from '@iconify/icons-vscode-icons/file-type-playwright';
import fileTypePnpm from '@iconify/icons-vscode-icons/file-type-pnpm';
import fileTypePostcss from '@iconify/icons-vscode-icons/file-type-postcss';
import fileTypePowerpoint from '@iconify/icons-vscode-icons/file-type-powerpoint';
import fileTypePrettier from '@iconify/icons-vscode-icons/file-type-prettier';
import fileTypePrisma from '@iconify/icons-vscode-icons/file-type-prisma';
import fileTypePython from '@iconify/icons-vscode-icons/file-type-python';
import fileTypeR from '@iconify/icons-vscode-icons/file-type-r';
import fileTypeReact from '@iconify/icons-vscode-icons/file-type-reactjs';
import fileTypeReactTs from '@iconify/icons-vscode-icons/file-type-reactts';
import fileTypeRollup from '@iconify/icons-vscode-icons/file-type-rollup';
import fileTypeRuby from '@iconify/icons-vscode-icons/file-type-ruby';
import fileTypeRust from '@iconify/icons-vscode-icons/file-type-rust';
import fileTypeSass from '@iconify/icons-vscode-icons/file-type-sass';
import fileTypeScss from '@iconify/icons-vscode-icons/file-type-scss';
import fileTypeShell from '@iconify/icons-vscode-icons/file-type-shell';
import fileTypeSql from '@iconify/icons-vscode-icons/file-type-sql';
import fileTypeSqlite from '@iconify/icons-vscode-icons/file-type-sqlite';
import fileTypeSvelte from '@iconify/icons-vscode-icons/file-type-svelte';
import fileTypeSvg from '@iconify/icons-vscode-icons/file-type-svg';
import fileTypeSwift from '@iconify/icons-vscode-icons/file-type-swift';
import fileTypeTailwind from '@iconify/icons-vscode-icons/file-type-tailwind';
import fileTypeTest from '@iconify/icons-vscode-icons/file-type-test';
import fileTypeToml from '@iconify/icons-vscode-icons/file-type-toml';
import fileTypeTsconfig from '@iconify/icons-vscode-icons/file-type-tsconfig';
import fileTypeTypescript from '@iconify/icons-vscode-icons/file-type-typescript';
import fileTypeTypescriptDef from '@iconify/icons-vscode-icons/file-type-typescriptdef';
import fileTypeVideo from '@iconify/icons-vscode-icons/file-type-video';
import fileTypeVite from '@iconify/icons-vscode-icons/file-type-vite';
import fileTypeVitest from '@iconify/icons-vscode-icons/file-type-vitest';
import fileTypeVue from '@iconify/icons-vscode-icons/file-type-vue';
import fileTypeWebpack from '@iconify/icons-vscode-icons/file-type-webpack';
import fileTypeWord from '@iconify/icons-vscode-icons/file-type-word';
import fileTypeXml from '@iconify/icons-vscode-icons/file-type-xml';
import fileTypeYaml from '@iconify/icons-vscode-icons/file-type-yaml';
import fileTypeYarn from '@iconify/icons-vscode-icons/file-type-yarn';
import fileTypeZip from '@iconify/icons-vscode-icons/file-type-zip';
import { File } from 'lucide-react';

type FileTypeIconProps = {
  extension: string | null;
  fileName: string;
};

const iconByExtension = new Map<string, unknown>([
  ['astro', fileTypeAstro],
  ['avi', fileTypeVideo],
  ['bash', fileTypeShell],
  ['bin', fileTypeBinary],
  ['bmp', fileTypeImage],
  ['c', fileTypeC],
  ['cjs', fileTypeJs],
  ['cpp', fileTypeCpp],
  ['cs', fileTypeCsharp],
  ['css', fileTypeCss],
  ['cts', fileTypeTypescript],
  ['dart', fileTypeDart],
  ['doc', fileTypeWord],
  ['docx', fileTypeWord],
  ['env', fileTypeDotenv],
  ['gif', fileTypeImage],
  ['go', fileTypeGo],
  ['graphql', fileTypeGraphql],
  ['gql', fileTypeGraphql],
  ['h', fileTypeC],
  ['hpp', fileTypeCpp],
  ['html', fileTypeHtml],
  ['ico', fileTypeImage],
  ['java', fileTypeJava],
  ['jpeg', fileTypeImage],
  ['jpg', fileTypeImage],
  ['js', fileTypeJs],
  ['json', fileTypeJson],
  ['json5', fileTypeJson],
  ['jsonc', fileTypeJson],
  ['jsx', fileTypeReact],
  ['kt', fileTypeKotlin],
  ['less', fileTypeLess],
  ['lock', fileTypeConfig],
  ['log', fileTypeLog],
  ['lua', fileTypeLua],
  ['m4v', fileTypeVideo],
  ['md', fileTypeMarkdown],
  ['mdx', fileTypeMdx],
  ['mjs', fileTypeJs],
  ['mov', fileTypeVideo],
  ['mp3', fileTypeAudio],
  ['mp4', fileTypeVideo],
  ['mts', fileTypeTypescript],
  ['pdf', fileTypePdf],
  ['php', fileTypePhp],
  ['png', fileTypeImage],
  ['ppt', fileTypePowerpoint],
  ['pptx', fileTypePowerpoint],
  ['prisma', fileTypePrisma],
  ['py', fileTypePython],
  ['r', fileTypeR],
  ['rb', fileTypeRuby],
  ['rs', fileTypeRust],
  ['sass', fileTypeSass],
  ['scss', fileTypeScss],
  ['sh', fileTypeShell],
  ['sql', fileTypeSql],
  ['sqlite', fileTypeSqlite],
  ['svg', fileTypeSvg],
  ['svelte', fileTypeSvelte],
  ['swift', fileTypeSwift],
  ['toml', fileTypeToml],
  ['ts', fileTypeTypescript],
  ['tsx', fileTypeReactTs],
  ['txt', fileTypeLog],
  ['vue', fileTypeVue],
  ['wav', fileTypeAudio],
  ['webm', fileTypeVideo],
  ['webp', fileTypeImage],
  ['xls', fileTypeExcel],
  ['xlsx', fileTypeExcel],
  ['xml', fileTypeXml],
  ['yaml', fileTypeYaml],
  ['yml', fileTypeYaml],
  ['zip', fileTypeZip],
  ['zsh', fileTypeShell],
]);

export function FileTypeIcon({ extension, fileName }: FileTypeIconProps) {
  const icon = resolveIcon(fileTypeIcon(fileName, extension));

  if (!icon) {
    return <File className="codex-md-file-icon codex-md-file-icon-fallback" aria-hidden={true} />;
  }

  const width = icon.width ?? 16;
  const height = icon.height ?? 16;
  const left = icon.left ?? 0;
  const top = icon.top ?? 0;

  return (
    <svg
      aria-hidden={true}
      className="codex-md-file-icon codex-md-file-iconify"
      focusable={false}
      viewBox={`${left} ${top} ${width} ${height}`}
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

export function fileTypeIconDataUri({ extension, fileName }: FileTypeIconProps) {
  const icon = resolveIcon(fileTypeIcon(fileName, extension));

  if (!icon) {
    return null;
  }

  const width = icon.width ?? 16;
  const height = icon.height ?? 16;
  const left = icon.left ?? 0;
  const top = icon.top ?? 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}">${icon.body}</svg>`;

  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function fileTypeIcon(fileName: string, extension: string | null): unknown {
  const normalized = fileName.toLowerCase();

  if (isTestFile(normalized)) {
    if (normalized.endsWith('.ts') || normalized.endsWith('.tsx')) {
      return fileTypeTest;
    }
    if (normalized.endsWith('.js') || normalized.endsWith('.jsx')) {
      return fileTypeTest;
    }
  }

  if (normalized.endsWith('.d.ts')) {
    return fileTypeTypescriptDef;
  }

  if (normalized === 'package.json') {
    return fileTypeNpm;
  }
  if (normalized === 'package-lock.json') {
    return fileTypeNpm;
  }
  if (normalized === 'pnpm-lock.yaml' || normalized === 'pnpm-workspace.yaml') {
    return fileTypePnpm;
  }
  if (normalized === 'yarn.lock') {
    return fileTypeYarn;
  }
  if (normalized === 'tsconfig.json' || normalized.startsWith('tsconfig.') || normalized.endsWith('.tsbuildinfo')) {
    return fileTypeTsconfig;
  }
  if (normalized.startsWith('vite.config.')) {
    return fileTypeVite;
  }
  if (normalized.startsWith('vitest.config.')) {
    return fileTypeVitest;
  }
  if (normalized.startsWith('playwright.config.')) {
    return fileTypePlaywright;
  }
  if (normalized.startsWith('tailwind.config.')) {
    return fileTypeTailwind;
  }
  if (normalized.startsWith('postcss.config.')) {
    return fileTypePostcss;
  }
  if (normalized.startsWith('babel.config.') || normalized === '.babelrc') {
    return fileTypeBabel;
  }
  if (normalized.startsWith('webpack.config.')) {
    return fileTypeWebpack;
  }
  if (normalized.startsWith('rollup.config.')) {
    return fileTypeRollup;
  }
  if (normalized.startsWith('eslint.config.') || normalized.startsWith('.eslint')) {
    return fileTypeEslint;
  }
  if (normalized.startsWith('.prettier')) {
    return fileTypePrettier;
  }
  if (normalized.startsWith('.env')) {
    return fileTypeDotenv;
  }
  if (normalized.startsWith('.git')) {
    return fileTypeGit;
  }
  if (normalized === 'dockerfile' || normalized.startsWith('dockerfile.')) {
    return fileTypeDocker;
  }
  if (normalized === 'license' || normalized.startsWith('license.')) {
    return fileTypeLicense;
  }

  return extension ? iconByExtension.get(extension) ?? null : null;
}

function resolveIcon(icon: unknown): IconifyIcon | null {
  const direct = icon as Partial<IconifyIcon> | null | undefined;
  if (typeof direct?.body === 'string') {
    return direct as IconifyIcon;
  }

  const defaultIcon = (icon as { default?: unknown } | null | undefined)?.default as Partial<IconifyIcon> | null | undefined;
  if (typeof defaultIcon?.body === 'string') {
    return defaultIcon as IconifyIcon;
  }

  const nestedDefaultIcon = (defaultIcon as { default?: unknown } | null | undefined)?.default as
    | Partial<IconifyIcon>
    | null
    | undefined;
  if (typeof nestedDefaultIcon?.body === 'string') {
    return nestedDefaultIcon as IconifyIcon;
  }

  return null;
}

function isTestFile(fileName: string) {
  return /(?:^|[.-])(test|spec)\.[^.]+$/i.test(fileName);
}
