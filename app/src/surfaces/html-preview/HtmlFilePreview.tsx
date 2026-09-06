import { hostFileHrefInfoFromHref, webUrlFromHref } from '@remux/viewer-kit/links';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { BrowserSection, ViewerTab } from '../../browser/browserTypes';
import type { RemuxConnection } from '../../remote/RemuxConnectionProvider';
import { useTheme, type RemuxTheme } from '../../theme/ThemeProvider';
import { HtmlPreviewRenderer } from './HtmlPreviewRenderer';
import { htmlPreviewAvailability } from './htmlPreviewAvailability';
import { prepareHtmlPreviewDocument } from './prepareHtmlPreviewDocument';
import {
  HtmlPreviewLoadController,
  type HtmlPreviewMode,
} from './htmlPreviewLoad';

type HtmlFilePreviewProps = {
  active: boolean;
  canLoad: boolean;
  onClose: () => void;
  onOpenFile: (target: { line?: number | null; path: string }) => { ok: boolean; reason?: string };
  onOpenOverview?: (section?: BrowserSection) => Promise<void> | void;
  controller: HtmlPreviewLoadController;
  query: RemuxConnection['query'];
  tab: ViewerTab;
};

export function HtmlFilePreview({
  active,
  canLoad,
  controller,
  onClose,
  onOpenFile,
  onOpenOverview,
  query,
  tab,
}: HtmlFilePreviewProps) {
  const theme = useTheme();
  const safeAreaInsets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const state = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.snapshot(), [controller]),
  );
  const availability = htmlPreviewAvailability(Platform.OS);
  const [linksVisible, setLinksVisible] = useState(false);
  const [rendererError, setRendererError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !availability.enabled || !canLoad || state.status !== 'idle') return;
    void controller.load(query, tab.id, prepareHtmlPreviewDocument);
  }, [active, availability.enabled, canLoad, controller, query, state.status, tab.id]);

  const refresh = useCallback(() => {
    setRendererError(null);
    void controller.load(query, tab.id, prepareHtmlPreviewDocument);
  }, [controller, query, tab.id]);
  const selectMode = useCallback((mode: HtmlPreviewMode) => {
    controller.setMode(mode);
  }, [controller]);

  const document = state.document;
  return (
    <View style={styles.shell}>
      <View style={[styles.header, { paddingTop: safeAreaInsets.top }]}>
        <View style={styles.modeRow}>
          <ModeButton active label="Preview" onPress={() => selectMode('preview')} styles={styles} />
          <ModeButton active={false} label="Source" onPress={() => selectMode('source')} styles={styles} />
        </View>
        <View style={styles.actionRow}>
          <StripButton disabled={!document} label="Links" onPress={() => setLinksVisible(true)} styles={styles} />
          <StripButton disabled={!availability.enabled || !canLoad} label="Refresh" onPress={refresh} styles={styles} />
          <StripButton label="Tabs" onPress={() => { void onOpenOverview?.('tabs'); }} styles={styles} />
          <StripButton label="Close" onPress={onClose} styles={styles} />
        </View>
        <Text style={styles.contentNote}>Self-contained HTML · Open linked files in Links</Text>
      </View>

      <View style={[styles.content, { paddingBottom: safeAreaInsets.bottom }]}>
        {!availability.enabled ? (
          <MessageCard
            action="Open Source"
            message={availability.reason ?? 'Interactive HTML preview is unavailable.'}
            onAction={() => selectMode('source')}
            styles={styles}
            title="Preview unavailable"
          />
        ) : !canLoad ? (
          <MessageCard
            action="Open Source"
            message="Reconnect to Remux to load this HTML file."
            onAction={() => selectMode('source')}
            styles={styles}
            title="Preview disconnected"
          />
        ) : state.status === 'loading' ? (
          <View style={styles.centered}>
            <ActivityIndicator color={theme.focusRing} />
            <Text style={styles.message}>Loading HTML preview</Text>
          </View>
        ) : !document ? (
          <MessageCard
            action="Retry"
            message={state.error ?? 'The HTML document could not be loaded.'}
            onAction={refresh}
            styles={styles}
            title="Could not open preview"
          />
        ) : !active ? null : rendererError ? (
          <MessageCard
            action="Reload"
            message={rendererError}
            onAction={refresh}
            styles={styles}
            title="Preview stopped"
          />
        ) : (
          <>
            <HtmlPreviewRenderer
              document={document}
              onError={setRendererError}
              onRenderProcessGone={() => setRendererError('The HTML preview process stopped. Reload to continue.')}
              testID="html-file-preview-renderer"
            />
            {state.status === 'refreshing' ? (
              <View style={styles.refreshing} pointerEvents="none">
                <ActivityIndicator color={theme.focusRing} />
              </View>
            ) : null}
            {state.error ? <Text style={styles.refreshError}>{state.error}</Text> : null}
          </>
        )}
      </View>

      <LinksModal
        baseFilePath={state.path}
        links={document?.links ?? []}
        linksTruncated={document?.linksTruncated ?? false}
        onClose={() => setLinksVisible(false)}
        onOpenFile={onOpenFile}
        styles={styles}
        visible={linksVisible}
      />
    </View>
  );
}

export function HtmlFileSourceHeader({
  onPreview,
}: {
  onPreview: () => void;
}) {
  const theme = useTheme();
  const safeAreaInsets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={[styles.header, styles.sourceHeader, { paddingTop: safeAreaInsets.top }]}>
      <View style={styles.modeRow}>
      <ModeButton active={false} label="Preview" onPress={onPreview} styles={styles} />
      <ModeButton active label="Source" onPress={() => undefined} styles={styles} />
      </View>
    </View>
  );
}

function ModeButton({ active, label, onPress, styles }: {
  active: boolean;
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.modeButton, active ? styles.modeButtonActive : null]}>
      <Text style={[styles.stripText, active ? styles.modeTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

function StripButton({ disabled = false, label, onPress, styles }: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={styles.stripButton}>
      <Text style={[styles.stripText, disabled ? styles.disabledText : null]}>{label}</Text>
    </Pressable>
  );
}

function MessageCard({ action, message, onAction, styles, title }: {
  action: string;
  message: string;
  onAction: () => void;
  styles: ReturnType<typeof createStyles>;
  title: string;
}) {
  return (
    <View style={styles.centered}>
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>
        <Pressable onPress={onAction} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>{action}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function LinksModal({ baseFilePath, links, linksTruncated, onClose, onOpenFile, styles, visible }: {
  baseFilePath: string;
  links: readonly { href: string; label: string }[];
  linksTruncated: boolean;
  onClose: () => void;
  onOpenFile: (target: { line?: number | null; path: string }) => { ok: boolean; reason?: string };
  styles: ReturnType<typeof createStyles>;
  visible: boolean;
}) {
  const [linkError, setLinkError] = useState<string | null>(null);
  const openLink = useCallback(async (href: string) => {
    setLinkError(null);
    try {
      const externalUrl = webUrlFromHref(href);
      if (externalUrl) {
        await Linking.openURL(externalUrl);
        onClose();
        return;
      }
      const target = hostFileHrefInfoFromHref(href, { baseFilePath, parseLine: true });
      if (!target) throw new Error('This link is not supported.');
      const result = onOpenFile({ line: target.line, path: target.path });
      if (!result.ok) throw new Error(result.reason || 'The linked file could not be opened.');
      onClose();
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : 'The link could not be opened.');
    }
  }, [baseFilePath, onClose, onOpenFile]);

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <Pressable onPress={onClose} style={styles.modalBackdrop}>
        <Pressable onPress={() => undefined} style={styles.linksSheet}>
          <View style={styles.linksHeader}>
            <Text style={styles.title}>Links</Text>
            <StripButton label="Done" onPress={onClose} styles={styles} />
          </View>
          <ScrollView>
            {links.length === 0 ? <Text style={styles.message}>No companion links in this document.</Text> : null}
            {links.map((link, index) => (
              <Pressable key={`${link.href}:${index}`} onPress={() => { void openLink(link.href); }} style={styles.linkRow}>
                <Text numberOfLines={1} style={styles.linkLabel}>{link.label}</Text>
                <Text numberOfLines={1} style={styles.linkHref}>{link.href}</Text>
              </Pressable>
            ))}
            {linksTruncated ? <Text style={styles.limitNote}>Showing the first 100 supported links.</Text> : null}
            {linkError ? <Text style={styles.linkError}>{linkError}</Text> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
    shell: { backgroundColor: theme.surface, flex: 1 },
    header: {
      backgroundColor: theme.surfaceRaised,
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 8,
    },
    sourceHeader: { minHeight: 44 },
    modeRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 4,
      minHeight: 44,
    },
    actionRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
    modeButton: { borderRadius: 8, justifyContent: 'center', minHeight: 44, paddingHorizontal: 11 },
    modeButtonActive: { backgroundColor: theme.focusRing },
    modeTextActive: { color: theme.surface },
    stripButton: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 9 },
    stripText: { color: theme.text, fontSize: 13, fontWeight: '600' },
    disabledText: { color: theme.textMuted },
    contentNote: { color: theme.textMuted, fontSize: 11, paddingBottom: 7, paddingHorizontal: 4 },
    content: { flex: 1 },
    centered: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
    card: { alignItems: 'flex-start', backgroundColor: theme.surfaceRaised, borderRadius: 14, gap: 10, maxWidth: 480, padding: 20 },
    title: { color: theme.text, fontSize: 17, fontWeight: '700' },
    message: { color: theme.textMuted, fontSize: 14, lineHeight: 20 },
    primaryButton: { backgroundColor: theme.focusRing, borderRadius: 9, marginTop: 4, paddingHorizontal: 13, paddingVertical: 9 },
    primaryButtonText: { color: theme.surface, fontSize: 14, fontWeight: '700' },
    refreshing: { position: 'absolute', right: 14, top: 14 },
    refreshError: { backgroundColor: theme.surfaceRaised, color: theme.text, padding: 10 },
    modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.42)', flex: 1, justifyContent: 'flex-end' },
    linksSheet: { backgroundColor: theme.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '70%', minHeight: 220, paddingBottom: 24 },
    linksHeader: { alignItems: 'center', borderBottomColor: theme.border, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', padding: 14 },
    linkRow: { borderBottomColor: theme.borderSubtle, borderBottomWidth: StyleSheet.hairlineWidth, gap: 3, paddingHorizontal: 16, paddingVertical: 12 },
    linkLabel: { color: theme.text, fontSize: 15, fontWeight: '600' },
    linkHref: { color: theme.textMuted, fontSize: 12 },
    limitNote: { color: theme.textMuted, fontSize: 12, padding: 16 },
    linkError: { color: theme.danger, fontSize: 13, padding: 16 },
  });
}
