import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { PropsWithChildren, ReactNode } from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const colors = {
  background: '#0a0a0a',
  drawer: '#141414',
  surface: '#1b1b1b',
  input: '#252525',
  media: '#141012',
  selected: '#571321',
  border: '#454140',
  text: '#f7f3ed',
  muted: '#c9c0b9',
  accent: '#b40022',
  note: '#f1a9af',
  white: '#ffffff',
  danger: '#ffd1d7',
  errorSurface: '#401820',
};

export const fonts = {
  display: 'PeekPoppinsExtraBold',
  regular: 'PeekPoppins',
  semibold: 'PeekPoppinsSemiBold',
  serif: 'PeekLora',
  serifBold: 'PeekLoraBold',
  italic: 'PeekLoraBoldItalic',
  mono: 'PeekMono',
  monoBold: 'PeekMonoBold',
  player: 'PeekBarlowCondensedBold',
};

export const gradients = {
  card: ['#2d2528', '#1c181a'],
  button: ['#29232a', '#1c191b'],
  selected: ['#69263b', '#411b29'],
  clip: ['#252121', '#40291d'],
  camera: ['#1f1c1c', '#131212', '#3c291c'],
  media: ['#23191c', '#171416'],
  profile: ['#571321', '#291419', '#141414'],
} as const;

const icons = {
  arrow: [require('../assets/peek/arrow.svg'), 12.4875, 10.2375],
  back: [require('../assets/peek/back.svg'), 6.05625, 10.8062],
  camera: [require('../assets/peek/camera.svg'), 18, 18],
  check: [require('../assets/peek/check.svg'), 13.0417, 9.70833],
  chevron: [require('../assets/peek/chevron.svg'), 5.7375, 10.2375],
  clip: [require('../assets/peek/clip.svg'), 40, 40],
  clipOff: [require('../assets/peek/clipOff.svg'), 40, 40],
  close: [require('../assets/peek/close.svg'), 18, 18],
  closeAccent: [require('../assets/peek/closeAccent.svg'), 20, 20],
  empty: [require('../assets/peek/empty.svg'), 44, 44],
  eye: [require('../assets/peek/eye.svg'), 16.2375, 10.2375],
  library: [require('../assets/peek/library.svg'), 19, 19],
  lock: [require('../assets/peek/lock.svg'), 18, 18],
  menu: [require('../assets/peek/menu.svg'), 22, 22],
  menuPlus: [require('../assets/peek/menuPlus.svg'), 18, 18],
  newChat: [require('../assets/peek/newChat.svg'), 21, 21],
  play: [require('../assets/peek/play.svg'), 16, 16],
  plus: [require('../assets/peek/plus.svg'), 20, 20],
  profile: [require('../assets/peek/profile.svg'), 28, 28],
  pulse: [require('../assets/peek/pulse.svg'), 34, 34],
  record: [require('../assets/peek/record.svg'), 14.7375, 13.2375],
  remove: [require('../assets/peek/remove.svg'), 12, 12],
  send: [require('../assets/peek/send.svg'), 18, 18],
  switch: [require('../assets/peek/switch.svg'), 18, 18],
  trash: [require('../assets/peek/trash.svg'), 14.7375, 14.7375],
  upload: [require('../assets/peek/upload.svg'), 18, 18],
  user: [require('../assets/peek/user.svg'), 40, 40],
  video: [require('../assets/peek/video.svg'), 34, 34],
  videoOff: [require('../assets/peek/videoOff.svg'), 34, 34],
  warning: [require('../assets/peek/warning.svg'), 16.4402, 14.1724],
} as const satisfies Record<string, readonly [number, number, number]>;

export type IconName = keyof typeof icons;
export const logoAsset: number = require('../assets/peek/logo.png');

export function Icon({ name }: { name: IconName }) {
  const [source, width, height] = icons[name];
  return <Image source={source} style={{ width, height }} accessible={false} />;
}

export function Brand({ size = 44, wordmark = false }: { size?: number; wordmark?: boolean }) {
  return (
    <View accessibilityLabel="Peek" accessible={wordmark} style={styles.brand}>
      <Image source={logoAsset} style={{ width: size, height: size * 1714 / 1820 }} contentFit="contain" accessible={false} />
      {wordmark ? <Text accessible={false} style={styles.wordmark}>eek</Text> : null}
    </View>
  );
}

export function IconButton({ icon, label, onPress, disabled, style }: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
      disabled={disabled} onPress={onPress} hitSlop={4}
      style={({ pressed }) => [styles.iconButton, style, (disabled || pressed) && styles.dimmed]}
    >
      <Icon name={icon} />
    </Pressable>
  );
}

export function Page({ children, keyboardShouldPersistTaps, style }: PropsWithChildren<{
  keyboardShouldPersistTaps?: 'handled';
  style?: StyleProp<ViewStyle>;
}>) {
  return (
    <ScrollView style={styles.page} contentContainerStyle={[styles.content, style]}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps} keyboardDismissMode="on-drag">
      {children}
    </ScrollView>
  );
}

export function Divider() {
  return (
    <Image source={require('../assets/peek/titleDivider.svg')} accessible={false}
      contentFit="fill" style={styles.divider} />
  );
}

export function Title({ title, subtitle, size }: { title: string; subtitle?: string; size?: number }) {
  const { width } = useWindowDimensions();
  const fontSize = size ?? (width < 375 ? 33 : 37);
  return (
    <View style={styles.title}>
      <Text style={[ui.heading, { fontSize, lineHeight: Math.ceil(fontSize * 1.2) }]} accessibilityRole="header">{title}</Text>
      <Divider />
      {subtitle ? <Text style={[ui.serif, styles.subtitle]}>{subtitle}</Text> : null}
    </View>
  );
}

export function Panel({ children, emphasis = false, style }: PropsWithChildren<{
  emphasis?: boolean;
  style?: StyleProp<ViewStyle>;
}>) {
  return <LinearGradient colors={emphasis ? gradients.profile : gradients.card} style={[styles.panel, style]}>{children}</LinearGradient>;
}

export function Strip({ label, detail }: { label: string; detail?: string }) {
  return (
    <View style={ui.row}>
      <Text style={ui.label}>{label}</Text>
      {detail ? <Text style={ui.mono}>{detail}</Text> : null}
    </View>
  );
}

export function Button({ label, onPress, disabled = false, kind = 'primary', selected, arrow = false, icon, style }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary' | 'danger';
  selected?: boolean;
  arrow?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const glyph = icon ?? (arrow ? (kind === 'primary' ? 'arrow' : 'chevron') : undefined);
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ disabled, selected }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, kind === 'primary' && styles.primary, style, (pressed || disabled) && styles.dimmed]}
    >
      {kind === 'secondary' ? (
        <LinearGradient colors={selected ? gradients.selected : gradients.button} style={StyleSheet.absoluteFill} />
      ) : null}
      {kind === 'danger' ? <View style={[StyleSheet.absoluteFill, styles.dangerBackground]} /> : null}
      <Text style={[styles.buttonLabel, kind === 'primary' && styles.primaryLabel, kind === 'danger' && styles.dangerLabel]}>
        {label}
      </Text>
      {glyph ? <Icon name={glyph} /> : null}
    </Pressable>
  );
}

export function TextButton({ label, onPress, disabled, style }: {
  label: string; onPress: () => void; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.textButton, style, (disabled || pressed) && styles.dimmed]}>
      <Text style={styles.textButtonLabel}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ label, onPress, selected }: { label: string; onPress: () => void; selected?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.selectedChip, pressed && styles.dimmed]}>
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

export function TopBar({ onMenu, center, trailing }: {
  onMenu: () => void;
  center?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.topbar}>
      <IconButton icon="menu" label="Open menu" onPress={onMenu} />
      <View style={styles.topbarCenter}>{center}</View>
      <View style={styles.topbarSide}>{trailing}</View>
    </View>
  );
}

export function ScreenHeader({ backLabel, onBack, backDisabled, detail, mark = false }: {
  backLabel?: string;
  onBack: () => void;
  backDisabled?: boolean;
  detail?: string;
  mark?: boolean;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityLabel={backLabel ? 'Back to ' + backLabel : 'Back'}
        accessibilityRole="button" accessibilityState={{ disabled: backDisabled }}
        disabled={backDisabled} hitSlop={4} onPress={onBack}
        style={({ pressed }) => [styles.back, (backDisabled || pressed) && styles.dimmed]}
      >
        <Icon name="back" />
        {backLabel ? <Text style={styles.backLabel}>{backLabel}</Text> : null}
      </Pressable>
      {detail ? <Text style={ui.label}>{detail}</Text> : null}
      {mark ? <Brand size={45} /> : null}
    </View>
  );
}

export function Sheet({ visible, onClose, children }: PropsWithChildren<{ visible: boolean; onClose: () => void }>) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
        <LinearGradient colors={gradients.card} style={styles.sheet}>
          <SafeAreaView edges={['bottom']} style={styles.sheetInner} accessibilityViewIsModal>
            <View style={styles.handle} />
            {children}
          </SafeAreaView>
        </LinearGradient>
      </View>
    </Modal>
  );
}

export function Placeholder({ children }: PropsWithChildren) {
  return <LinearGradient colors={gradients.media} style={styles.placeholder}>{children}</LinearGradient>;
}

export function StatsGrid({ stats, showFg = false }: {
  stats: { makes: number; attempts: number; unmarked: number; percentage: number | null };
  showFg?: boolean;
}) {
  const percentage = stats.percentage ?? 0;
  return (
    <View style={styles.stats}>
      <View style={styles.stat} accessible accessibilityLabel={stats.percentage === null ? 'No tagged attempts' : String(percentage) + ' percent made'}>
        <View style={styles.ring}>
          {percentage > 0 ? <RingHalf side="right" degrees={Math.min(percentage, 50) * 3.6} /> : null}
          {percentage > 50 ? <RingHalf side="left" degrees={(percentage - 50) * 3.6} /> : null}
          <Text style={styles.ringValue}>{stats.percentage === null ? '—' : String(percentage) + '%'}</Text>
        </View>
        {showFg ? <Text style={styles.statLabel}>FG%</Text> : null}
      </View>
      <View style={styles.stat} accessible accessibilityLabel={String(stats.makes) + ' made in ' + String(stats.attempts) + ' attempts'}>
        <Text style={styles.statValue}>{stats.makes} / {stats.attempts}</Text>
        <Text style={styles.statLabel}>Made</Text>
      </View>
      <View style={styles.stat} accessible accessibilityLabel={String(stats.unmarked) + ' unmarked'}>
        <Text style={styles.statValue}>{stats.unmarked}</Text>
        <Text style={styles.statLabel}>Unmarked</Text>
      </View>
    </View>
  );
}

function RingHalf({ side, degrees }: { side: 'right' | 'left'; degrees: number }) {
  const right = side === 'right';
  return (
    <View pointerEvents="none" style={[styles.ringHalf, right ? styles.right : styles.left]}>
      <View style={[styles.ringRotor, { left: right ? -27 : 0, transform: [{ rotate: String(degrees) + 'deg' }] }]}>
        <View style={[styles.ringHalf, { top: 0, left: right ? 0 : 27 }]}>
          <View style={[styles.ringProgress, { left: right ? 0 : -27 }]} />
        </View>
      </View>
    </View>
  );
}

export function Loading({ text }: { text: string }) {
  return <View style={styles.center}><ActivityIndicator color={colors.note} /><Text style={ui.body}>{text}</Text></View>;
}

export function Notice({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <View accessible accessibilityRole="alert" style={styles.notice}>
      {icon ? <Icon name={icon} /> : null}
      <Text style={styles.noticeText}>{children}</Text>
    </View>
  );
}

export function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const ui = StyleSheet.create({
  heading: { color: colors.text, fontFamily: fonts.display, fontSize: 37, lineHeight: 44, letterSpacing: -0.8, textTransform: 'uppercase' },
  drill: { color: colors.text, fontFamily: fonts.display, fontSize: 36, lineHeight: 42 },
  title: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18, lineHeight: 25 },
  body: { color: colors.muted, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  serif: { color: colors.muted, fontFamily: fonts.serif, fontSize: 15, lineHeight: 22 },
  text: { color: colors.text, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  label: { color: colors.note, fontFamily: fonts.mono, fontSize: 11, lineHeight: 15, letterSpacing: 0.25 },
  mono: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, lineHeight: 15, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  group: { gap: 10 },
  time: { color: colors.text, fontFamily: fonts.mono, fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
});

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 10, paddingBottom: 20, gap: 14 },
  panel: { borderRadius: 20, padding: 14, gap: 10, overflow: 'hidden' },
  title: { gap: 2 },
  divider: { width: '94%', maxWidth: 321.002, height: 1 },
  subtitle: { marginTop: 3 },
  brand: { flexDirection: 'row', alignItems: 'center' },
  wordmark: { color: colors.text, fontFamily: fonts.semibold, fontSize: 17, lineHeight: 25, marginLeft: -11, marginTop: 12 },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  topbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 48 },
  topbarCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topbarSide: { minWidth: 44, alignItems: 'flex-end' },
  header: { ...ui.row, paddingHorizontal: 24, minHeight: 56 },
  back: { minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingLeft: 4, gap: 10 },
  backLabel: { color: colors.text, fontFamily: fonts.semibold, fontSize: 14 },
  placeholder: { minHeight: 196, justifyContent: 'center', alignItems: 'center', padding: 20, borderRadius: 22 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10 },
  button: {
    minHeight: 52, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 28, flexDirection: 'row',
    justifyContent: 'space-between', alignItems: 'center', gap: 9, overflow: 'hidden',
  },
  primary: { backgroundColor: colors.accent },
  primaryLabel: { color: colors.white },
  dangerBackground: { backgroundColor: colors.errorSurface, borderWidth: 1, borderColor: '#8a3d4d', borderRadius: 28 },
  dangerLabel: { color: colors.danger },
  buttonLabel: { color: colors.text, flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15 },
  dimmed: { opacity: 0.58 },
  textButton: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  textButtonLabel: { color: colors.note, fontFamily: fonts.semibold, fontSize: 14 },
  chip: {
    minHeight: 38, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 7,
  },
  selectedChip: { backgroundColor: colors.selected, borderColor: '#793044' },
  chipText: { ...ui.text, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  notice: { backgroundColor: colors.errorSurface, borderRadius: 20, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 11 },
  noticeText: { ...ui.body, color: colors.danger, fontSize: 13, flexShrink: 1 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000b' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
  sheetInner: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24, gap: 10 },
  handle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center' },
  stats: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  stat: { flex: 1, alignItems: 'center', gap: 3, minWidth: 0 },
  ring: {
    width: 54, height: 54, borderRadius: 27, backgroundColor: 'transparent', borderColor: '#3b3635',
    borderWidth: 4, alignItems: 'center', justifyContent: 'center', overflow: 'visible',
  },
  ringHalf: { position: 'absolute', width: 27, height: 54, top: -4, overflow: 'hidden' },
  right: { left: 23 },
  left: { left: -4 },
  ringRotor: { position: 'absolute', top: 0, width: 54, height: 54 },
  ringProgress: { position: 'absolute', width: 54, height: 54, borderRadius: 27, borderWidth: 4, borderColor: colors.note },
  ringValue: { color: colors.text, fontFamily: fonts.monoBold, fontSize: 14, letterSpacing: -0.45 },
  statValue: { color: colors.text, fontFamily: fonts.monoBold, fontSize: 21, textAlign: 'center' },
  statLabel: { ...ui.mono, fontSize: 10, textTransform: 'uppercase' },
});
