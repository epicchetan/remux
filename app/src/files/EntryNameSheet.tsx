import { useEffect, useMemo, useState } from 'react';
import type { PresentationDetent } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { alpha, useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { isValidEntryName, parentPath } from './fileMutations';
import {
  FileSheet,
  FileSheetButton,
  FileSheetFooter,
  FileSheetHeader,
  FileSheetMessage,
} from './fileSheet';
import type { EntryNameRequest } from './useFileActions';

// A detent list that ends in `large` lets UIKit grow the sheet when the
// keyboard comes up; the field and the buttons stay pinned to the top.
const detents: PresentationDetent[] = [{ height: 268 }, 'large'];

export function EntryNameSheet({
  onClose,
  onSubmit,
  request,
}: {
  onClose: () => void;
  onSubmit: (name: string) => void;
  request: EntryNameRequest | null;
}) {
  const { styles, theme } = useEntryNameTheme();
  const [name, setName] = useState('');
  const rename = request?.mode === 'rename';
  const initialName = request?.initialName ?? '';
  const visible = request?.visible === true;

  useEffect(() => {
    if (visible) {
      setName(initialName);
    }
  }, [initialName, visible]);

  const canSubmit = isValidEntryName(name) && (!rename || name !== initialName);
  const directory = request
    ? rename ? parentPath(request.target.path) : request.target.path
    : '';

  return (
    <FileSheet
      detents={detents}
      dismissDisabled={request?.busy === true}
      onClose={onClose}
      visible={visible}
    >
      <FileSheetHeader
        subtitle={`In ${directory}`}
        title={rename ? 'Rename' : 'New folder'}
      />

      <View style={styles.field}>
        <TextInput
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          autoFocus
          editable={!request?.busy}
          onChangeText={setName}
          onSubmitEditing={() => {
            if (canSubmit) {
              onSubmit(name);
            }
          }}
          placeholder={rename ? 'New name' : 'Folder name'}
          placeholderTextColor={alpha(theme.textMuted, 0.72)}
          returnKeyType="done"
          selectionColor={theme.focusRing}
          selectTextOnFocus
          style={styles.input}
          value={name}
        />
      </View>

      {request?.error ? <FileSheetMessage text={request.error} /> : null}

      <FileSheetFooter>
        <View style={styles.footerSlot}>
          <FileSheetButton
            disabled={request?.busy === true}
            label="Cancel"
            onPress={onClose}
          />
        </View>
        <View style={styles.footerSlot}>
          <FileSheetButton
            busy={request?.busy === true}
            disabled={!canSubmit}
            label={rename ? 'Rename' : 'Create'}
            onPress={() => onSubmit(name)}
            tone="primary"
          />
        </View>
      </FileSheetFooter>

      <Text style={styles.hint}>
        Names cannot contain a slash.
      </Text>
    </FileSheet>
  );
}

function useEntryNameTheme() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return { styles, theme };
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
    field: {
      backgroundColor: theme.surfaceRaised,
      borderColor: theme.border,
      borderRadius: 14,
      borderWidth: 1,
      justifyContent: 'center',
      marginHorizontal: 18,
      marginTop: 16,
      minHeight: 48,
      paddingHorizontal: 14,
    },
    footerSlot: {
      flex: 1,
    },
    hint: {
      color: theme.textMuted,
      fontSize: 12,
      lineHeight: 16,
      marginTop: 12,
      paddingHorizontal: 18,
    },
    input: {
      color: theme.text,
      fontSize: 16,
      fontWeight: '600',
      lineHeight: 20,
      padding: 0,
    },
  });
}
