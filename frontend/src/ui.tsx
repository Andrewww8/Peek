import type { PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export const colors = {
  background: '#101114',
  surface: '#1B1C21',
  input: '#24262D',
  border: '#383A43',
  text: '#F6F6FA',
  muted: '#A8AAB7',
  accent: '#C7F36A',
  ink: '#172005',
  danger: '#FF9C9C',
};

export function Page({ children }: PropsWithChildren) {
  return <ScrollView style={styles.page} contentContainerStyle={styles.content}>{children}</ScrollView>;
}

export function Panel({ children }: PropsWithChildren) {
  return <View style={styles.panel}>{children}</View>;
}

export function Button({ label, onPress, disabled = false, kind = 'primary', selected }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary' | 'danger';
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button, kind === 'primary' ? styles.primary : styles.secondary,
        selected && styles.selected, (pressed || disabled) && styles.dimmed,
      ]}
    >
      <Text style={[
        styles.buttonLabel, kind === 'primary' && styles.primaryLabel,
        kind === 'danger' && styles.dangerLabel,
      ]}>{label}</Text>
    </Pressable>
  );
}

export function ScreenHeader({ title, onBack, backDisabled }: {
  title: string;
  onBack: () => void;
  backDisabled?: boolean;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityLabel="Go back"
        accessibilityRole="button"
        accessibilityState={{ disabled: backDisabled }}
        disabled={backDisabled}
        hitSlop={4}
        onPress={onBack}
        style={({ pressed }) => [styles.back, (backDisabled || pressed) && styles.dimmed]}
      >
        <Text style={styles.backArrow}>‹</Text>
      </Pressable>
      <Text accessibilityRole="header" style={styles.headerTitle}>{title}</Text>
    </View>
  );
}

export function Placeholder({ children }: PropsWithChildren) {
  return <View style={styles.placeholder}>{children}</View>;
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
  heading: { color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -1.15 },
  title: { color: colors.text, fontSize: 21, fontWeight: '700', letterSpacing: -0.35 },
  body: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  text: { color: colors.text, fontSize: 15, lineHeight: 21 },
  label: { color: colors.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  group: { gap: 10 },
  time: { color: colors.muted, fontSize: 13, fontVariant: ['tabular-nums'] },
});

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: 20, paddingBottom: 28, gap: 20 },
  panel: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 18, padding: 16, gap: 12 },
  placeholder: { minHeight: 152, justifyContent: 'center', alignItems: 'center', padding: 20, borderRadius: 18, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  body: { ...ui.body, textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 4, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '700', flexShrink: 1 },
  back: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  backArrow: { color: colors.text, fontSize: 38, lineHeight: 41, marginTop: -4 },
  button: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  secondary: { backgroundColor: colors.input, borderColor: colors.border },
  selected: { borderColor: colors.accent },
  dimmed: { opacity: 0.55 },
  buttonLabel: { color: colors.text, textAlign: 'center', fontSize: 15, fontWeight: '700' },
  primaryLabel: { color: colors.ink },
  dangerLabel: { color: colors.danger },
  notice: { color: colors.danger, fontSize: 14, lineHeight: 21 },
});
