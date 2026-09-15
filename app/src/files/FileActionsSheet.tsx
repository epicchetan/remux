import { useMemo } from 'react';
import type { PresentationDetent } from '@expo/ui/swift-ui/modifiers';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { FileSheet, FileSheetHeader, fileSheetChromeHeight } from './fileSheet';
import type { FileActionKind, FileActionsRequest } from './useFileActions';

const actionRowHeight = 52;
const headerHeight = 58;
const rowsGap = 14;

const actionLabels: Record<FileActionKind, string> = {
  'copy-path': 'Copy path',
  delete: 'Delete',
  download: 'Download',
  'new-folder': 'New folder',
  rename: 'Rename',
  'upload-files': 'Upload files',
  'upload-photos': 'Upload photos',
};

export function FileActionsSheet({
  onClose,
  onDismissed,
  onSelect,
  request,
}: {
  onClose: () => void;
  onDismissed: () => void;
  onSelect: (action: FileActionKind) => void;
  request: FileActionsRequest | null;
}) {
  const insets = useSafeAreaInsets();
  const styles = useActionStyles();
  const actionCount = request?.actions.length ?? 0;
  const detents = useMemo<PresentationDetent[]>(() => [{
    height: headerHeight + rowsGap + (actionCount * actionRowHeight) + fileSheetChromeHeight(insets.bottom),
  }], [actionCount, insets.bottom]);

  return (
    <FileSheet
      detents={detents}
      onClose={onClose}
      onDismissed={onDismissed}
      visible={request?.visible === true}
    >
      <FileSheetHeader
        subtitle={request?.target.isDirectory ? 'Folder' : 'File'}
        title={request?.target.name ?? ''}
      />
      <View style={styles.rows}>
        {(request?.actions ?? []).map((action, index) => (
          <ActionRow
            action={action}
            first={index === 0}
            key={action}
            onPress={() => onSelect(action)}
            styles={styles}
          />
        ))}
      </View>
    </FileSheet>
  );
}

type ActionStyles = ReturnType<typeof createStyles>;

function ActionRow({
  action,
  first,
  onPress,
  styles,
}: {
  action: FileActionKind;
  first: boolean;
  onPress: () => void;
  styles: ActionStyles;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        first ? null : styles.rowDivided,
        pressed ? styles.rowPressed : null,
      ]}
    >
      <Text style={[styles.rowLabel, action === 'delete' ? styles.rowLabelDestructive : null]}>
        {actionLabels[action]}
      </Text>
    </Pressable>
  );
}

function useActionStyles() {
  const theme = useTheme();
  return useMemo(() => createStyles(theme), [theme]);
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
    row: {
      height: actionRowHeight,
      justifyContent: 'center',
      paddingHorizontal: 18,
    },
    rowDivided: {
      borderTopColor: theme.borderSubtle,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    rowLabel: {
      color: theme.text,
      fontSize: 17,
      fontWeight: '600',
      lineHeight: 22,
    },
    rowLabelDestructive: {
      color: theme.danger,
    },
    rowPressed: {
      backgroundColor: theme.overlay,
    },
    rows: {
      marginTop: rowsGap,
    },
  });
}
