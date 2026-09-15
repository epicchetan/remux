import { useEffect, useMemo, useState } from 'react';
import type { PresentationDetent } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, TextInput, View } from 'react-native';

import { alpha, useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import {
  FileSheet,
  FileSheetButton,
  FileSheetFooter,
  FileSheetHeader,
  FileSheetMessage,
} from './fileSheet';
import type { DeleteConfirmRequest } from './useFileActions';

const confirmDetents: PresentationDetent[] = [{ height: 236 }];
// The typed confirmation needs the keyboard, so it offers `large` as well.
const typedDetents: PresentationDetent[] = [{ height: 320 }, 'large'];

export function DeleteConfirmSheet({
  onClose,
  onConfirm,
  request,
}: {
  onClose: () => void;
  onConfirm: () => void;
  request: DeleteConfirmRequest | null;
}) {
  const { styles, theme } = useDeleteConfirmTheme();
  const [typedName, setTypedName] = useState('');
  const name = request?.target.name ?? '';
  const recursive = request?.recursive === true;
  const visible = request?.visible === true;

  useEffect(() => {
    if (!visible || !recursive) {
      setTypedName('');
    }
  }, [recursive, visible]);

  const canDelete = !recursive || typedName === name;

  return (
    <FileSheet
      detents={recursive ? typedDetents : confirmDetents}
      dismissDisabled={request?.busy === true}
      onClose={onClose}
      visible={visible}
    >
      <FileSheetHeader
        subtitle={recursive
          ? `Everything inside ${name} will be permanently removed. There is no trash.`
          : `This permanently removes ${request?.target.isDirectory ? 'the folder' : 'the file'} on the host. There is no trash.`}
        title={`Delete ${name}?`}
      />

      {recursive ? (
        <View style={styles.field}>
          <TextInput
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            autoFocus
            editable={!request?.busy}
            onChangeText={setTypedName}
            placeholder={`Type ${name} to confirm`}
            placeholderTextColor={alpha(theme.textMuted, 0.72)}
            returnKeyType="done"
            selectionColor={theme.focusRing}
            style={styles.input}
            value={typedName}
          />
        </View>
      ) : null}

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
            disabled={!canDelete}
            label="Delete"
            onPress={onConfirm}
            tone="destructive"
          />
        </View>
      </FileSheetFooter>
    </FileSheet>
  );
}

function useDeleteConfirmTheme() {
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
    input: {
      color: theme.text,
      fontSize: 16,
      fontWeight: '600',
      lineHeight: 20,
      padding: 0,
    },
  });
}
