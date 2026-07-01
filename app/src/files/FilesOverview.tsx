import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Button,
  Host,
  Text as SwiftText,
  ZStack,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel as swiftAccessibilityLabel,
  buttonStyle,
  frame,
  font,
  foregroundStyle,
  glassEffect,
  lineLimit,
  padding,
  truncationMode,
} from '@expo/ui/swift-ui/modifiers';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  type ViewToken,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getBottomBarHeight, tabGridGap, tabGridHorizontalPadding } from '../browser/browserLayout';
import { useBrowserStore } from '../browser/browserStore';
import { useRemuxConnection } from '../remote/RemuxConnectionProvider';
import { alpha, useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { NativeGlassIconButton } from '../ui/NativeGlassIconButton';
import {
  fileExtensionForName,
  matchingFileHandlers,
} from './fileHandlers';
import {
  filesRootKey,
  useFilesStore,
  visibleFileTreeRows,
  type DirectoryRecord,
} from './filesStore';
import type { VisibleFileTreeRow } from './filesTypes';

const rowHeight = 64;
const rowIndent = 20;
const rowGap = 12;
const navigationButtonSize = 40;
const navigationIconSize = 16;
const headerSideWidth = 48;
const headerTitleGap = 12;
const headerTopPadding = 4;
const headerBottomPadding = 2;
const headerListGap = 8;
const preloadDirectoryBatchSize = 4;
const preloadDirectoryDelayMs = 60;

const navigationButtonModifiers = [
  buttonStyle('plain'),
];

export function FilesOverview() {
  const currentPath = useFilesStore((state) => state.currentPath);
  const directoriesByPath = useFilesStore((state) => state.directoriesByPath);
  const expandedPaths = useFilesStore((state) => state.expandedPaths);
  const insets = useSafeAreaInsets();
  const loadRootDirectory = useFilesStore((state) => state.loadRootDirectory);
  const navigateToParentDirectory = useFilesStore((state) => state.navigateToParentDirectory);
  const preloadDirectories = useFilesStore((state) => state.preloadDirectories);
  const request = useRemuxConnection().request;
  const preloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [viewablePaths, setViewablePaths] = useState<string[]>([]);
  const rows = useMemo(
    () => visibleFileTreeRows({ currentPath, directoriesByPath, expandedPaths }),
    [currentPath, directoriesByPath, expandedPaths],
  );
  const viewablePathSet = useMemo(() => new Set(viewablePaths), [viewablePaths]);
  const preloadRows = useMemo(() => {
    if (viewablePathSet.size === 0) {
      return rows.slice(0, preloadDirectoryBatchSize);
    }

    return rows.filter((row) => viewablePathSet.has(row.path));
  }, [rows, viewablePathSet]);
  const preloadPaths = useMemo(
    () => preloadRows
      .filter((row) => {
        return (
          row.kind === 'directory' &&
          isAutoPreloadCandidate(row) &&
          !row.childrenLoaded &&
          !isDirectoryFetching(directoriesByPath[row.path]) &&
          !directoriesByPath[row.path]?.error
        );
      })
      .slice(0, preloadDirectoryBatchSize)
      .map((row) => row.path),
    [directoriesByPath, preloadRows],
  );
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 15,
    minimumViewTime: 80,
  });
  const onViewableItemsChanged = useRef(({
    viewableItems,
  }: {
    viewableItems: ViewToken<VisibleFileTreeRow>[];
  }) => {
    setViewablePaths(viewableItems.flatMap((item) => (
      item.item?.path ? [item.item.path] : []
    )));
  });
  const currentRecord = currentPath
    ? directoriesByPath[currentPath]
    : directoriesByPath[filesRootKey];
  const currentParentPath = currentRecord?.parentPath ?? null;
  const currentLoading = currentRecord?.refreshStatus === 'loading';
  const currentError = currentRecord?.error ?? null;
  const { styles } = useFilesTheme();
  const listTopPadding =
    insets.top +
    headerTopPadding +
    navigationButtonSize +
    headerBottomPadding +
    headerListGap;
  const listBottomPadding = getBottomBarHeight(insets.bottom) + tabGridGap;

  useEffect(() => {
    void loadRootDirectory(request);
  }, [loadRootDirectory, request]);

  useEffect(() => {
    if (preloadPaths.length === 0) {
      return;
    }

    if (preloadTimerRef.current !== null) {
      clearTimeout(preloadTimerRef.current);
    }

    preloadTimerRef.current = setTimeout(() => {
      preloadTimerRef.current = null;
      void preloadDirectories(request, preloadPaths);
    }, preloadDirectoryDelayMs);

    return () => {
      if (preloadTimerRef.current !== null) {
        clearTimeout(preloadTimerRef.current);
        preloadTimerRef.current = null;
      }
    };
  }, [preloadDirectories, preloadPaths, request]);

  return (
    <View style={styles.container}>
      <FlatList
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={[
          {
            paddingBottom: listBottomPadding,
            paddingTop: listTopPadding,
          },
        ]}
        data={rows}
        ListEmptyComponent={
          <FilesStatus
            error={currentError}
            loading={currentLoading}
          />
        }
        keyboardShouldPersistTaps="handled"
        keyExtractor={(row) => row.path}
        onViewableItemsChanged={onViewableItemsChanged.current}
        renderItem={({ item }) => <FileTreeRow row={item} />}
        showsVerticalScrollIndicator={false}
        viewabilityConfig={viewabilityConfig.current}
      />
      <FilesHeader
        canNavigateBack={Boolean(currentParentPath)}
        currentPath={currentPath}
        onBackPress={() => {
          void navigateToParentDirectory(request);
        }}
        topInset={insets.top}
      />
    </View>
  );
}

function FilesHeader({
  canNavigateBack,
  currentPath,
  onBackPress,
  topInset,
}: {
  canNavigateBack: boolean;
  currentPath: string | null;
  onBackPress: () => void;
  topInset: number;
}) {
  const { styles } = useFilesTheme();
  const { width } = useWindowDimensions();
  const titleWidth = Math.max(
    0,
    width - (tabGridHorizontalPadding * 2) - headerSideWidth - headerTitleGap,
  );

  return (
    <View style={[styles.header, { paddingTop: topInset + headerTopPadding }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerSide}>
          <NativeGlassIconButton
            accessibilityLabel="Back"
            disabled={!canNavigateBack}
            iconSize={navigationIconSize}
            onPress={onBackPress}
            size={navigationButtonSize}
            systemImage="chevron.left"
          />
        </View>

        <NativeTitleButton title={currentPath ?? 'Files'} width={titleWidth} />

      </View>
    </View>
  );
}

function NativeTitleButton({
  title,
  width,
}: {
  title: string;
  width: number;
}) {
  const theme = useTheme();
  const titleTextModifiers = useMemo(() => [
    font({
      size: 15,
      weight: 'bold',
    }),
    foregroundStyle(theme.text),
    lineLimit(1),
    truncationMode('head'),
    padding({
      horizontal: 14,
    }),
  ], [theme.text]);
  const { styles } = useFilesTheme();

  return (
    <Host style={[styles.headerTitleHost, { width }]}>
      <Button
        modifiers={[
          ...navigationButtonModifiers,
          swiftAccessibilityLabel('Directory path'),
        ]}
        onPress={() => undefined}
      >
        <ZStack
          modifiers={[
            frame({
              alignment: 'center',
              height: navigationButtonSize,
              width,
            }),
            glassEffect({
              glass: {
                interactive: true,
                variant: 'regular',
              },
              shape: 'capsule',
            }),
          ]}
        >
          <SwiftText modifiers={titleTextModifiers}>{title}</SwiftText>
        </ZStack>
      </Button>
    </Host>
  );
}

function FileTreeRow({ row }: { row: VisibleFileTreeRow }) {
  const { styles, theme } = useFilesTheme();
  const extensions = useBrowserStore((state) => state.extensions);
  const openResource = useBrowserStore((state) => state.openResource);
  const request = useRemuxConnection().request;
  const record = useFilesStore((state) => state.directoriesByPath[row.path]);
  const error = record?.error ?? null;
  const loading = record?.refreshStatus === 'loading';
  const navigateToDirectory = useFilesStore((state) => state.navigateToDirectory);
  const toggleFolder = useFilesStore((state) => state.toggleFolder);
  const fileHandler = matchingFileHandlers(extensions, row)[0] ?? null;
  const showSpinner = row.kind === 'directory' && loading && !row.childrenLoaded && !error;
  const showChevron = row.kind === 'directory' && !showSpinner && row.hasChildren && !error;
  const canToggle = showChevron;
  const canOpen = row.kind === 'directory' || Boolean(fileHandler);
  const meta = fileRowMeta(row, loading, error);

  return (
    <View style={styles.row}>
      <View style={[styles.rowContent, { paddingLeft: row.depth * rowIndent }]}>
        <Pressable
          accessibilityLabel={canToggle ? `${row.isExpanded ? 'Collapse' : 'Expand'} ${row.name}` : undefined}
          accessibilityRole={canToggle ? 'button' : undefined}
          disabled={!canToggle}
          hitSlop={8}
          onPress={() => {
            void toggleFolder(request, row.path);
          }}
          style={[
            styles.chevronButton,
            !showSpinner && !showChevron ? styles.chevronButtonDisabled : null,
          ]}
        >
          {showSpinner ? (
            <ActivityIndicator color={theme.focusRing} size="small" />
          ) : showChevron ? (
            <ChevronIcon direction={row.isExpanded ? 'down' : 'right'} styles={styles} />
          ) : null}
        </Pressable>

        <Pressable
          accessibilityLabel={row.kind === 'directory' ? `Open ${row.name}` : row.name}
          accessibilityRole={canOpen ? 'button' : undefined}
          disabled={!canOpen}
          onPress={() => {
            if (row.kind === 'directory') {
              void navigateToDirectory(request, row.path, row.parentPath);
              return;
            }

            if (fileHandler) {
              void openResource({
                extensionId: fileHandler.extensionId,
                handlerId: fileHandler.id,
                resourceId: row.path,
                resourceKind: 'file',
                title: row.name,
                viewId: fileHandler.view,
              });
            }
          }}
          style={({ pressed }) => [
            styles.rowBody,
            pressed ? styles.rowBodyPressed : null,
          ]}
        >
          <View style={styles.iconSlot}>
            {row.kind === 'directory'
              ? <FolderIcon styles={styles} />
              : <FileIcon fileName={row.name} styles={styles} theme={theme} />}
          </View>

          <View style={styles.rowText}>
            <View style={styles.rowTextContent}>
              <Text numberOfLines={1} style={styles.rowTitle}>{row.name}</Text>
              {meta ? <Text numberOfLines={1} style={styles.rowMeta}>{meta}</Text> : null}
            </View>
            <GitStatusBadge git={row.git} styles={styles} theme={theme} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

type FilesStyles = ReturnType<typeof createStyles>;

function GitStatusBadge({
  git,
  styles,
  theme,
}: {
  git: VisibleFileTreeRow['git'];
  styles: FilesStyles;
  theme: RemuxTheme;
}) {
  if (!git) {
    return null;
  }

  const tone = gitStatusTone(git.status, theme);
  return (
    <View
      accessibilityLabel={`Git ${git.status}`}
      style={[
        styles.gitStatusBadge,
        {
          backgroundColor: tone.backgroundColor,
          borderColor: tone.borderColor,
        },
      ]}
    >
      <Text style={[styles.gitStatusBadgeText, { color: tone.color }]}>
        {gitStatusLabel(git.status)}
      </Text>
    </View>
  );
}

function FilesStatus({
  error,
  loading,
}: {
  error: string | null;
  loading: boolean;
}) {
  const { styles } = useFilesTheme();

  if (!loading && !error) {
    return null;
  }

  return (
    <View style={styles.status}>
      <Text style={styles.statusText}>{error ?? 'Reading directory'}</Text>
    </View>
  );
}

function FolderIcon({ styles }: { styles: FilesStyles }) {
  return (
    <View style={styles.folderIcon}>
      <View style={styles.folderTab} />
      <View style={styles.folderBody} />
    </View>
  );
}

function ChevronIcon({
  direction,
  styles,
}: {
  direction: 'down' | 'right';
  styles: FilesStyles;
}) {
  return (
    <View
      style={[
        styles.chevronIcon,
        direction === 'down' ? styles.chevronIconDown : styles.chevronIconRight,
      ]}
    />
  );
}

function FileIcon({
  fileName,
  styles,
  theme,
}: {
  fileName: string;
  styles: FilesStyles;
  theme: RemuxTheme;
}) {
  const extension = fileNameExtension(fileName);
  const accent = fileAccentColor(extension, theme);

  return (
    <View style={styles.fileIcon}>
      <View style={[styles.fileAccent, { backgroundColor: accent }]} />
      <Text numberOfLines={1} style={styles.fileExtension}>{extension || 'file'}</Text>
    </View>
  );
}

function fileRowMeta(row: VisibleFileTreeRow, isLoading: boolean, error?: string | null) {
  if (error) {
    return error;
  }

  if (isLoading) {
    return 'Reading directory';
  }

  if (row.kind === 'directory') {
    const itemCount = row.itemCount == null ? null : `${row.itemCount} ${row.itemCount === 1 ? 'item' : 'items'}`;
    return [formatModifiedAt(row.modifiedAtMs), itemCount].filter(Boolean).join(' - ');
  }

  return [formatModifiedAt(row.modifiedAtMs), formatSize(row.sizeBytes)].filter(Boolean).join(' - ');
}

function isDirectoryFetching(record: DirectoryRecord | undefined) {
  return record?.refreshStatus === 'loading' || record?.refreshStatus === 'refreshing';
}

function isAutoPreloadCandidate(row: VisibleFileTreeRow) {
  if (row.name.startsWith('.')) {
    return false;
  }

  switch (row.name) {
    case '.git':
    case '.next':
    case 'build':
    case 'coverage':
    case 'dist':
    case 'node_modules':
      return false;
    default:
      return true;
  }
}

function fileNameExtension(fileName: string) {
  return fileExtensionForName(fileName)?.slice(0, 4) ?? '';
}

function formatModifiedAt(modifiedAtMs: number | null | undefined) {
  if (!modifiedAtMs) {
    return null;
  }

  const modifiedAt = new Date(modifiedAtMs);
  if (Number.isNaN(modifiedAt.getTime())) {
    return null;
  }

  const now = new Date();
  if (modifiedAt.toDateString() === now.toDateString()) {
    return 'Today';
  }

  return modifiedAt.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

function formatSize(sizeBytes: number | null | undefined) {
  if (sizeBytes == null) {
    return null;
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${Math.ceil(sizeBytes / 1024)} KB`;
  }

  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileAccentColor(extension: string, theme: RemuxTheme) {
  switch (extension) {
    case 'js':
    case 'json':
      return theme.warning;
    case 'md':
    case 'mdx':
      return theme.textMuted;
    case 'ts':
    case 'tsx':
      return theme.focusRing;
    default:
      return theme.textMuted;
  }
}

function gitStatusLabel(status: NonNullable<VisibleFileTreeRow['git']>['status']) {
  switch (status) {
    case 'added':
    case 'untracked':
      return '+';
    case 'conflicted':
      return '!';
    case 'deleted':
      return '-';
    case 'modified':
      return 'M';
    case 'renamed':
      return 'R';
    default:
      return '';
  }
}

function gitStatusTone(status: NonNullable<VisibleFileTreeRow['git']>['status'], theme: RemuxTheme) {
  switch (status) {
    case 'added':
    case 'untracked':
      return {
        backgroundColor: alpha(theme.success, 0.14),
        borderColor: alpha(theme.success, 0.32),
        color: theme.success,
      };
    case 'deleted':
    case 'conflicted':
      return {
        backgroundColor: alpha(theme.danger, 0.14),
        borderColor: alpha(theme.danger, 0.32),
        color: theme.danger,
      };
    case 'renamed':
      return {
        backgroundColor: alpha(theme.focusRing, 0.14),
        borderColor: alpha(theme.focusRing, 0.3),
        color: theme.focusRing,
      };
    case 'modified':
    default:
      return {
        backgroundColor: alpha(theme.warning, 0.14),
        borderColor: alpha(theme.warning, 0.3),
        color: theme.warning,
      };
  }
}

function useFilesTheme() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return { styles, theme };
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
  chevronButton: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 28,
  },
  chevronButtonDisabled: {
    opacity: 0,
  },
  chevronIcon: {
    borderBottomColor: theme.focusRing,
    borderBottomWidth: 2.5,
    borderRightColor: theme.focusRing,
    borderRightWidth: 2.5,
    height: 11,
    width: 11,
  },
  chevronIconDown: {
    transform: [{ rotate: '45deg' }, { translateX: -1 }, { translateY: -2 }],
  },
  chevronIconRight: {
    transform: [{ rotate: '-45deg' }, { translateX: -2 }],
  },
  container: {
    backgroundColor: theme.surface,
    flex: 1,
  },
  fileAccent: {
    borderRadius: 2,
    height: 4,
    left: 6,
    position: 'absolute',
    right: 6,
    top: 7,
  },
  fileExtension: {
    color: theme.textMuted,
    fontSize: 8,
    fontWeight: '800',
    lineHeight: 10,
    maxWidth: 28,
    textTransform: 'uppercase',
  },
  fileIcon: {
    alignItems: 'center',
    backgroundColor: theme.surfaceRaised,
    borderColor: theme.border,
    borderRadius: 6,
    borderWidth: 1,
    height: 30,
    justifyContent: 'center',
    width: 28,
  },
  folderBody: {
    backgroundColor: alpha(theme.focusRing, 0.58),
    borderColor: alpha(theme.focusRing, 0.78),
    borderRadius: 4,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 5,
    borderWidth: 1,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 7,
  },
  folderIcon: {
    height: 30,
    position: 'relative',
    width: 36,
  },
  folderTab: {
    backgroundColor: alpha(theme.focusRing, 0.58),
    borderColor: alpha(theme.focusRing, 0.78),
    borderRadius: 4,
    borderWidth: 1,
    height: 12,
    left: 0,
    position: 'absolute',
    top: 1,
    width: 20,
  },
  gitStatusBadge: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    height: 18,
    justifyContent: 'center',
    marginLeft: 8,
    minWidth: 22,
    paddingHorizontal: 5,
  },
  gitStatusBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    lineHeight: 14,
  },
  iconSlot: {
    alignItems: 'center',
    flexShrink: 0,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  header: {
    left: 0,
    paddingBottom: 2,
    paddingHorizontal: tabGridHorizontalPadding,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 2,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: navigationButtonSize,
  },
  headerSide: {
    alignItems: 'flex-start',
    flexShrink: 0,
    width: headerSideWidth,
  },
  headerSideRight: {
    alignItems: 'flex-end',
  },
  headerTitleHost: {
    height: navigationButtonSize,
    marginHorizontal: headerTitleGap,
  },
  row: {
    height: rowHeight,
    paddingHorizontal: tabGridHorizontalPadding,
  },
  rowBody: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: rowGap,
    height: rowHeight,
  },
  rowBodyPressed: {
    opacity: 0.72,
  },
  rowContent: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: rowGap,
    height: rowHeight,
  },
  rowMeta: {
    color: theme.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 1,
  },
  rowText: {
    alignItems: 'center',
    borderBottomColor: theme.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flex: 1,
    flexDirection: 'row',
    height: rowHeight,
    minWidth: 0,
  },
  rowTextContent: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  rowTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '500',
    lineHeight: 22,
  },
  status: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
    paddingHorizontal: tabGridHorizontalPadding,
  },
  statusText: {
    color: theme.textMuted,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  });
}
