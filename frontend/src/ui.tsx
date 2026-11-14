import type { PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export const colors = {
  background: '#11191E',
  surface: '#1A272F',
  input: '#16252E',
  media: '#0D171D',
  band: '#234C5D',
  selected: '#244953',
  border: '#36505D',
  text: '#F2F7F8',
  muted: '#A7BAC4',
  accent: '#79DEEC',
  note: '#9BE7EF',
  ink: '#0D232A',
  danger: '#FFB889',
  errorSurface: '#422C25',
};

export const fonts = {
  display: 'BarlowCondensed',
  regular: 'InstrumentSans',
  semibold: 'InstrumentSansSemibold',
  mono: 'IBMPlexMono',
};

export function Page({ children, keyboardShouldPersistTaps }: PropsWithChildren<{ keyboardShouldPersistTaps?: 'handled' }>) {
  return <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps={keyboardShouldPersistTaps}>{children}</ScrollView>;
}

export function Panel({ children, emphasis = false }: PropsWithChildren<{ emphasis?: boolean }>) {
  return <View style={[styles.panel, emphasis && styles.emphasis]}>{children}</View>;
}

export function Strip({ label, detail }: { label: string; detail?: string }) {
  return (
    <View style={styles.strip}>
      <Text style={[ui.mono, styles.stripLabel]}>{label}</Text>
      {detail ? <Text style={[ui.mono, styles.stripDetail]}>{detail}</Text> : null}
    </View>
  );
}

export function Button({ label, onPress, disabled = false, kind = 'primary', selected, arrow = false }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary' | 'danger';
  selected?: boolean;
  arrow?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button, kind === 'primary' ? styles.primary : styles.secondary,
        selected && styles.selected, arrow && styles.linkButton,
        arrow && kind === 'primary' && styles.mainAction, (pressed || disabled) && styles.dimmed,
      ]}
    >
      <Text style={[
        styles.buttonLabel, kind === 'primary' && styles.primaryLabel,
        kind === 'danger' && styles.dangerLabel,
      ]}>{label}</Text>
      {arrow ? <Text accessible={false} style={[styles.arrow, kind === 'primary' && styles.primaryLabel]}>{kind === 'primary' ? '→' : '›'}</Text> : null}
    </Pressable>
  );
}

export function ScreenHeader({ backLabel, onBack, backDisabled, detail }: {
  backLabel: string;
  onBack: () => void;
  backDisabled?: boolean;
  detail?: string;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityLabel={`Back to ${backLabel}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: backDisabled }}
        disabled={backDisabled}
        hitSlop={4}
        onPress={onBack}
        style={({ pressed }) => [styles.back, (backDisabled || pressed) && styles.dimmed]}
      >
        <Text accessible={false} style={styles.backArrow}>‹</Text>
        <Text style={styles.backLabel}>{backLabel}</Text>
      </Pressable>
      {detail ? <Text style={[ui.mono, styles.headerDetail]}>{detail}</Text> : null}
    </View>
  );
}

export function Placeholder({ children }: PropsWithChildren) {
  return <View style={styles.placeholder}>{children}</View>;
}

export function StatsGrid({ stats }: { stats: { makes: number; attempts: number; unmarked: number; percentage: number | null } }) {
  const values = [
    { label: 'FG%', value: stats.percentage === null ? '—' : `${stats.percentage}%`, spoken: stats.percentage === null ? 'No tagged attempts' : `${stats.percentage} percent made` },
    { label: 'Made', value: `${stats.makes} / ${stats.attempts}`, spoken: `${stats.makes} made in ${stats.attempts} attempts` },
    { label: 'Unmarked', value: String(stats.unmarked), spoken: `${stats.unmarked} unmarked` },
  ];
  return (
    <View style={styles.stats}>
      {values.map(({ label, value, spoken }, index) => (
        <View accessible accessibilityLabel={spoken} key={label} style={[styles.stat, index === 0 && styles.firstStat]}>
          <Text style={styles.statValue}>{value}</Text>
          <Text style={styles.statLabel}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

export function Loading({ text }: { text: string }) {
  return <View style={styles.center}><ActivityIndicator color={colors.accent} /><Text style={styles.body}>{text}</Text></View>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <Text accessibilityRole="alert" style={styles.notice}>{children}</Text>;
}

export function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const ui = StyleSheet.create({
  heading: { color: colors.text, fontFamily: fonts.display, fontSize: 48, lineHeight: 49, textTransform: 'uppercase' },
  drill: { color: colors.text, fontFamily: fonts.display, fontSize: 55, lineHeight: 51, textTransform: 'uppercase' },
  title: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18, lineHeight: 23 },
  body: { color: colors.muted, fontFamily: fonts.regular, fontSize: 15, lineHeight: 21 },
  text: { color: colors.text, fontFamily: fonts.regular, fontSize: 15, lineHeight: 21 },
  label: { color: colors.accent, fontFamily: fonts.mono, fontSize: 11, lineHeight: 15, letterSpacing: 1.05 },
  mono: { color: colors.muted, fontFamily: fonts.mono, fontSize: 11, lineHeight: 15, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 },
  group: { gap: 10 },
  time: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
});

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: 24, paddingTop: 14, paddingBottom: 24, gap: 14 },
  panel: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 9, padding: 15, gap: 10 },
  emphasis: { backgroundColor: colors.selected, borderColor: colors.selected },
  strip: { ...ui.row, backgroundColor: colors.band, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 8 },
  stripLabel: { color: colors.text, letterSpacing: 0.7 },
  stripDetail: { color: colors.note, letterSpacing: 0.3 },
  placeholder: { minHeight: 196, justifyContent: 'center', alignItems: 'center', padding: 20, borderRadius: 12, backgroundColor: colors.media },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  body: { ...ui.body, textAlign: 'center' },
  header: { ...ui.row, paddingHorizontal: 24, paddingVertical: 2 },
  headerDetail: { color: colors.note, backgroundColor: colors.surface, paddingVertical: 6, paddingHorizontal: 9, borderRadius: 6 },
  back: { minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 },
  backArrow: { color: colors.text, fontSize: 26, lineHeight: 28 },
  backLabel: { color: colors.text, fontFamily: fonts.semibold, fontSize: 14 },
  button: { minHeight: 46, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 9, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  linkButton: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  mainAction: { minHeight: 54 },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  secondary: { backgroundColor: colors.surface, borderColor: colors.border },
  selected: { backgroundColor: colors.selected, borderColor: colors.accent },
  dimmed: { opacity: 0.55 },
  buttonLabel: { color: colors.text, flexShrink: 1, fontFamily: fonts.semibold, textAlign: 'center', fontSize: 15 },
  arrow: { color: colors.note, fontSize: 19, lineHeight: 22 },
  primaryLabel: { color: colors.ink },
  dangerLabel: { color: colors.danger },
  notice: { color: colors.danger, backgroundColor: colors.errorSurface, borderRadius: 8, padding: 12, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 1, backgroundColor: colors.border, borderWidth: 1, borderColor: colors.border, borderRadius: 5, overflow: 'hidden' },
  stat: { flex: 1, minWidth: 72, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6, gap: 2, backgroundColor: colors.media },
  firstStat: { backgroundColor: colors.band },
  statValue: { color: colors.text, fontFamily: fonts.mono, fontSize: 18, lineHeight: 23, textAlign: 'center' },
  statLabel: { ...ui.mono, fontSize: 10, textTransform: 'uppercase', textAlign: 'center' },
});
