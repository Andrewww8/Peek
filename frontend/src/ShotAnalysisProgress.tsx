import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { getShotAnalysisState, subscribeToShotAnalysis } from './guest-pose';
import { clipTime } from './practice';
import { colors, ui } from './ui';

const phaseLabel = {
  queued: 'Analysis queued',
  detecting: 'Finding release…',
  tracking: 'Tracking shot…',
  complete: 'Comparison ready',
  failed: 'Analysis incomplete',
};

export function ShotAnalysisProgress({ sessionId, tag, style }: {
  sessionId: string;
  tag?: { shotNumber: number; releaseMs: number };
  style?: StyleProp<ViewStyle>;
}) {
  const state = useSyncExternalStore(subscribeToShotAnalysis, () => getShotAnalysisState(sessionId, tag));
  const [now, setNow] = useState(Date.now);
  const active = state?.phase === 'queued' || state?.phase === 'detecting' || state?.phase === 'tracking';

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);

  if (!state) return null;

  const progress = Math.round(state.progress * 100);
  const percentage = state.phase === 'complete' ? 100 : Math.max(0, Math.min(99, progress));
  const elapsedMs = state.startedAt === undefined ? undefined
    : Math.max(0, (state.finishedAt ?? now) - state.startedAt);
  const duration = elapsedMs === undefined ? undefined
    : elapsedMs < 60_000 ? (elapsedMs / 1000).toFixed(1) + 's' : clipTime(elapsedMs);
  const timing = duration ? (state.phase === 'complete' ? 'in ' + duration : duration + ' elapsed') : undefined;

  return (
    <View style={[styles.progress, style]}>
      <View style={styles.statusRow}>
        <Text style={styles.status} accessibilityLiveRegion="polite">{phaseLabel[state.phase]}</Text>
        <Text style={styles.detail}>
          {state.phase === 'failed' ? timing : timing ? `${percentage}% · ${timing}` : `${percentage}%`}
        </Text>
      </View>
      {state.phase === 'failed' ? (
        <Text style={styles.error}>{state.error || 'Try a clearer recording or choose a tagged shot.'}</Text>
      ) : (
        <View
          style={styles.track}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Shot analysis"
          accessibilityValue={{ min: 0, max: 100, now: percentage }}
        >
          <View style={[styles.fill, { width: `${percentage}%` }]} />
        </View>
      )}
    </View>
  );
}

export function RecordingSaveProgress() {
  const position = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const motion = Animated.loop(Animated.timing(position, {
      toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: false,
    }));
    motion.start();
    return () => motion.stop();
  }, [position]);

  return (
    <View style={styles.progress}>
      <Text style={styles.status} accessibilityLiveRegion="polite">Saving to this iPhone…</Text>
      <View style={styles.track} accessible accessibilityRole="progressbar" accessibilityLabel="Saving recording">
        <Animated.View style={[styles.fill, styles.saveFill, {
          left: position.interpolate({ inputRange: [0, 1], outputRange: ['-33%', '100%'] }),
        }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  progress: { gap: 6, minWidth: 0 },
  statusRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 },
  status: { ...ui.text, fontSize: 12, lineHeight: 16 },
  detail: { ...ui.label, textTransform: 'none' },
  error: { ...ui.body, color: colors.danger, fontSize: 12, lineHeight: 16 },
  track: { backgroundColor: colors.border, height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { backgroundColor: colors.note, height: '100%', borderRadius: 3 },
  saveFill: { position: 'absolute', width: '33%' },
});
