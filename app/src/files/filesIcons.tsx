import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { alpha, useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { iconExtensionForName } from './fileHandlers';

// Pure RN-drawn glyphs. Per-row SwiftUI Hosts (SF Symbols) ghosted and
// overlapped during FlatList cell recycling on expand/collapse, so rows must
// not contain native hosted views — see docs/specs/files-tab.md.

export const FolderGlyph = memo(function FolderGlyph() {
  const theme = useTheme();

  return (
    <View style={styles.folder}>
      <View style={[styles.folderTab, { backgroundColor: theme.focusRing }]} />
      <View style={[styles.folderBody, { backgroundColor: theme.focusRing }]} />
    </View>
  );
});

export const FileGlyph = memo(function FileGlyph({ fileName }: { fileName: string }) {
  const theme = useTheme();
  const tint = fileTintForName(fileName, theme);
  const lineColor = alpha(theme.textMuted, 0.45);

  return (
    <View
      style={[
        styles.page,
        {
          backgroundColor: theme.surfaceRaised,
          borderColor: theme.border,
        },
      ]}
    >
      <View style={[styles.pageAccent, { backgroundColor: tint }]} />
      <View style={[styles.pageLine, styles.pageLineWide, { backgroundColor: lineColor }]} />
      <View style={[styles.pageLine, styles.pageLineNarrow, { backgroundColor: lineColor }]} />
    </View>
  );
});

function fileTintForName(fileName: string, theme: RemuxTheme): string {
  switch (iconExtensionForName(fileName)) {
    case 'c':
    case 'cjs':
    case 'cpp':
    case 'go':
    case 'java':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'py':
    case 'rb':
    case 'rs':
    case 'swift':
    case 'ts':
    case 'tsx':
      return theme.focusRing;
    case 'env':
    case 'json':
    case 'lock':
    case 'plist':
    case 'toml':
    case 'yaml':
    case 'yml':
      return theme.warning;
    case 'avif':
    case 'gif':
    case 'jpeg':
    case 'jpg':
    case 'png':
    case 'svg':
    case 'webp':
      return theme.success;
    case 'bash':
    case 'command':
    case 'sh':
    case 'zsh':
      return theme.text;
    default:
      return theme.textMuted;
  }
}

const styles = StyleSheet.create({
  folder: {
    height: 24,
    width: 30,
  },
  folderBody: {
    borderRadius: 5,
    borderTopLeftRadius: 3,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 5,
  },
  folderTab: {
    borderTopLeftRadius: 3,
    borderTopRightRadius: 5,
    height: 9,
    left: 0,
    position: 'absolute',
    top: 0,
    width: 14,
  },
  page: {
    borderRadius: 5,
    borderWidth: 1,
    height: 28,
    paddingHorizontal: 4,
    paddingTop: 6,
    width: 22,
  },
  pageAccent: {
    borderRadius: 1.5,
    height: 3,
  },
  pageLine: {
    borderRadius: 1,
    height: 2,
    marginTop: 3,
  },
  pageLineNarrow: {
    width: '50%',
  },
  pageLineWide: {
    width: '80%',
  },
});
