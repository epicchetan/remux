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
  const [overlay, setOverlay] = useState<'links' | 'menu' | null>(null);
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
      <View style={[styles.content, { paddingTop: safeAreaInsets.top }]}>
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

      <View style={[styles.actionBar, { paddingBottom: Math.max(12, safeAreaInsets.bottom) }]}>
        <View style={styles.actionButtons}>
          <IconButton
            icon="tabs"
            label="Open tabs"
            onPress={() => { void onOpenOverview?.('tabs'); }}
            styles={styles}
          />
          <IconButton
            icon="menu"
            label="HTML preview menu"
            onPress={() => setOverlay('menu')}
            styles={styles}
          />
        </View>
        <Text
          numberOfLines={1}
          pointerEvents="none"
          style={[styles.fileName, { bottom: Math.max(1, (Math.max(12, safeAreaInsets.bottom) - 10) / 2) }]}
        >
          {fileName(state.path)}
        </Text>
      </View>

      <PreviewOverlay
        baseFilePath={state.path}
        bottomInset={safeAreaInsets.bottom}
        canReload={availability.enabled && canLoad}
        hasDocument={Boolean(document)}
        links={document?.links ?? []}
        linksTruncated={document?.linksTruncated ?? false}
        onClose={onClose}
        onDismiss={() => setOverlay(null)}
        onLinks={() => setOverlay('links')}
        onOpenFile={onOpenFile}
        onReload={() => {
          setOverlay(null);
          refresh();
        }}
        onSource={() => {
          setOverlay(null);
          selectMode('source');
        }}
        styles={styles}
        view={overlay}
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
    <View style={[styles.sourceHeader, { paddingTop: safeAreaInsets.top }]}>
      <Pressable accessibilityLabel="Back to HTML preview" accessibilityRole="button" onPress={onPreview} style={styles.backButton}>
        <Text style={styles.backButtonText}>‹ Preview</Text>
      </Pressable>
    </View>
  );
}

function IconButton({ icon, label, onPress, styles }: {
  icon: 'menu' | 'tabs';
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.iconButton, pressed ? styles.iconButtonPressed : null]}>
      {icon === 'menu' ? <MenuGlyph styles={styles} /> : <TabsGlyph styles={styles} />}
    </Pressable>
  );
}

function PreviewOverlay({ baseFilePath, bottomInset, canReload, hasDocument, links, linksTruncated, onClose, onDismiss, onLinks, onOpenFile, onReload, onSource, styles, view }: {
  baseFilePath: string;
  bottomInset: number;
  canReload: boolean;
  hasDocument: boolean;
  links: readonly { href: string; label: string }[];
  linksTruncated: boolean;
  onClose: () => void;
  onDismiss: () => void;
  onLinks: () => void;
  onOpenFile: (target: { line?: number | null; path: string }) => { ok: boolean; reason?: string };
  onReload: () => void;
  onSource: () => void;
  styles: ReturnType<typeof createStyles>;
  view: 'links' | 'menu' | null;
}) {
  const [linkError, setLinkError] = useState<string | null>(null);
  const openLink = useCallback(async (href: string) => {
    setLinkError(null);
    try {
      const externalUrl = webUrlFromHref(href);
      if (externalUrl) await Linking.openURL(externalUrl);
      else {
        const target = hostFileHrefInfoFromHref(href, { baseFilePath, parseLine: true });
        if (!target) throw new Error('This link is not supported.');
        const result = onOpenFile({ line: target.line, path: target.path });
        if (!result.ok) throw new Error(result.reason || 'The linked file could not be opened.');
      }
      onDismiss();
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : 'The link could not be opened.');
    }
  }, [baseFilePath, onDismiss, onOpenFile]);

  return (
    <Modal animationType="fade" onRequestClose={onDismiss} transparent visible={view !== null}>
      <Pressable onPress={onDismiss} style={[styles.menuBackdrop, view === 'links' ? styles.modalBackdrop : null]}>
        {view === 'links' ? (
          <Pressable onPress={() => undefined} style={[styles.linksSheet, { paddingBottom: Math.max(24, bottomInset) }]}>
            <View style={styles.linksHeader}>
              <Text style={styles.title}>Links</Text>
              <Pressable accessibilityLabel="Close links" accessibilityRole="button" onPress={onDismiss} style={styles.doneButton}>
                <Text style={styles.doneButtonText}>Done</Text>
              </Pressable>
            </View>
            <ScrollView>
              <Text style={styles.linksHelp}>Self-contained HTML does not load sibling assets. Open companion files here.</Text>
              {links.length === 0 ? <Text style={styles.message}>No companion links in this document.</Text> : null}
              {links.map((link, index) => (
                <Pressable accessibilityRole="button" key={`${link.href}:${index}`} onPress={() => { void openLink(link.href); }} style={styles.linkRow}>
                  <Text numberOfLines={1} style={styles.linkLabel}>{link.label}</Text>
                  <Text numberOfLines={1} style={styles.linkHref}>{link.href}</Text>
                </Pressable>
              ))}
              {linksTruncated ? <Text style={styles.limitNote}>Showing the first 100 supported links.</Text> : null}
              {linkError ? <Text style={styles.linkError}>{linkError}</Text> : null}
            </ScrollView>
          </Pressable>
        ) : (
          <View style={[styles.menuPanel, { bottom: 58 + Math.max(12, bottomInset) }]}>
            <MenuItem label="View source" onPress={onSource} styles={styles} />
            <MenuItem disabled={!hasDocument} label="Links" onPress={onLinks} styles={styles} />
            <MenuItem disabled={!canReload} label="Reload preview" onPress={onReload} styles={styles} />
            <MenuItem danger label="Close tab" onPress={() => { onDismiss(); onClose(); }} styles={styles} />
          </View>
        )}
      </Pressable>
    </Modal>
  );
}

function MenuItem({ danger = false, disabled = false, label, onPress, styles }: {
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.menuItem}>
      <Text style={[styles.menuItemText, danger ? styles.menuItemDanger : null, disabled ? styles.menuItemDisabled : null]}>{label}</Text>
    </Pressable>
  );
}

function TabsGlyph({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return <View style={styles.tabsGlyph}><View style={styles.tabsDivider} /><View style={styles.tabsChevronTop} /><View style={styles.tabsChevronBottom} /></View>;
}

function MenuGlyph({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return <View style={styles.menuGlyph}><View style={styles.menuLine} /><View style={styles.menuLine} /><View style={styles.menuLine} /></View>;
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
        <Pressable accessibilityRole="button" onPress={onAction} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>{action}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
    shell: { backgroundColor: theme.surface, flex: 1 },
    content: { flex: 1 },
    actionBar: {
      alignItems: 'center',
      backgroundColor: theme.surfaceRaised,
      borderTopColor: theme.borderSubtle,
      borderTopWidth: StyleSheet.hairlineWidth,
      justifyContent: 'center',
      minHeight: 58,
      paddingHorizontal: 18,
      paddingTop: 10,
      position: 'relative',
    },
    actionButtons: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 7 },
    iconButton: {
      alignItems: 'center',
      backgroundColor: theme.surfaceHover,
      borderColor: theme.border,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 2,
      height: 36,
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { height: 1, width: 0 },
      shadowOpacity: 0.18,
      shadowRadius: 2,
      width: 39,
    },
    iconButtonPressed: { elevation: 0, transform: [{ translateY: 1 }] },
    fileName: { color: theme.textMuted, fontSize: 9, left: 18, lineHeight: 10, position: 'absolute', right: 18, textAlign: 'center' },
    tabsGlyph: { borderColor: theme.textMuted, borderRadius: 2, borderWidth: 1.5, height: 15, position: 'relative', width: 18 },
    tabsDivider: { backgroundColor: theme.textMuted, bottom: 0, position: 'absolute', right: 5, top: 0, width: 1.5 },
    tabsChevronTop: { backgroundColor: theme.textMuted, height: 1.5, left: 3, position: 'absolute', top: 5, transform: [{ rotate: '-38deg' }], width: 5 },
    tabsChevronBottom: { backgroundColor: theme.textMuted, bottom: 4, height: 1.5, left: 3, position: 'absolute', transform: [{ rotate: '38deg' }], width: 5 },
    menuGlyph: { gap: 2.5, width: 16 },
    menuLine: { backgroundColor: theme.textMuted, borderRadius: 1, height: 1.5, width: 16 },
    menuBackdrop: { flex: 1 },
    menuPanel: {
      backgroundColor: theme.surfaceRaised,
      borderColor: theme.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 8,
      left: 18,
      padding: 3,
      position: 'absolute',
      shadowColor: '#000',
      shadowOffset: { height: 4, width: 0 },
      shadowOpacity: 0.24,
      shadowRadius: 10,
      width: 232,
    },
    menuItem: { justifyContent: 'center', minHeight: 40, paddingHorizontal: 10 },
    menuItemText: { color: theme.text, fontSize: 14 },
    menuItemDanger: { color: theme.danger },
    menuItemDisabled: { color: theme.textMuted, opacity: 0.42 },
    sourceHeader: { alignItems: 'flex-start', backgroundColor: theme.surfaceRaised, borderBottomColor: theme.borderSubtle, borderBottomWidth: StyleSheet.hairlineWidth, justifyContent: 'center', minHeight: 44, paddingHorizontal: 12 },
    backButton: { justifyContent: 'center', minHeight: 40, paddingHorizontal: 6 },
    backButtonText: { color: theme.textMuted, fontSize: 14, fontWeight: '600' },
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
    doneButton: { justifyContent: 'center', minHeight: 40, paddingHorizontal: 8 },
    doneButtonText: { color: theme.focusRing, fontSize: 14, fontWeight: '700' },
    linkRow: { borderBottomColor: theme.borderSubtle, borderBottomWidth: StyleSheet.hairlineWidth, gap: 3, paddingHorizontal: 16, paddingVertical: 12 },
    linksHelp: { color: theme.textMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingVertical: 12 },
    linkLabel: { color: theme.text, fontSize: 15, fontWeight: '600' },
    linkHref: { color: theme.textMuted, fontSize: 12 },
    limitNote: { color: theme.textMuted, fontSize: 12, padding: 16 },
    linkError: { color: theme.danger, fontSize: 13, padding: 16 },
  });
}

function fileName(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) || path;
}
