import Slider from '@react-native-community/slider';
import { File, Paths } from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, ScrollView, StyleSheet, Text, View } from 'react-native';

import { accountFetch, apiUrl } from './api';
import { accessToken } from './auth';
import { bones, comparisonUsdz, coordinatesPerFrame, jointCount, poseGround } from './pose-3d';
import type { Pose, PoseSample } from './pose-3d';
import { Button, Chip, colors, gradients, Loading, message, Notice, Page, Panel, ScreenHeader, Title, ui } from './ui';

type Reference = { player: string; shotsAveraged: number; pose: Pose };
type ShotSource = { sessionId: string; shotNumber: number; userId: string | null };

const references: Reference[] = require('../assets/peek-nba-poses.json');
const preferred = references.find(({ player }) => player === 'Stephen Curry') ?? references[0]!;
const example = references.find(({ player }) => player === 'Damian Lillard') ?? references[1]!;

async function loadShotPose(source: ShotSource, signal: AbortSignal): Promise<Pose> {
  const { userId, sessionId, shotNumber } = source;
  if (!userId) throw new Error('Sign in to open your synced shot.');
  const request = accountFetch(apiUrl, (renew) => accessToken(userId, renew));
  const response = await request('/v1/sessions/' + encodeURIComponent(sessionId) + '/shots/' + String(shotNumber) + '/pose', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  const body = await response.json() as { pose?: Pose; shotType?: string; message?: string };
  if (!response.ok) throw new Error(body.message || 'Could not load the 3D pose.');
  const pose = body.pose;
  if (body.shotType !== 'three_point' || !pose || pose.fps !== preferred.pose.fps ||
      pose.releaseIndex !== preferred.pose.releaseIndex || pose.frameCount !== preferred.pose.frameCount ||
      !Array.isArray(pose.joints) || pose.joints.length !== pose.frameCount * coordinatesPerFrame) {
    throw new Error('This shot could not be lined up with the three-point reference.');
  }
  return pose;
}

export function ComparisonScreen({ source, backLabel, onBack }: {
  source?: ShotSource;
  backLabel: string;
  onBack: () => void;
}) {
  const [pose, setPose] = useState<Pose>();
  const [notice, setNotice] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const sessionId = source?.sessionId;
  const shotNumber = source?.shotNumber;
  const userId = source?.userId ?? null;

  useEffect(() => {
    if (!sessionId || !shotNumber) return;
    const controller = new AbortController();
    setNotice(undefined);
    setPose(undefined);
    void loadShotPose({ sessionId, shotNumber, userId }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPose(result);
    }, (error) => {
      if (!controller.signal.aborted) setNotice(message(error, 'The 3D pose could not be loaded.'));
    });
    return () => controller.abort();
  }, [sessionId, shotNumber, userId, attempt]);

  return (
    <>
      <ScreenHeader backLabel={backLabel} detail="3D COMPARISON" onBack={onBack} />
      <Page>
        <Title title="Compare shot" subtitle={source ? 'Shot ' + String(shotNumber) + ' · Catch-and-shoot three' : 'NBA reference shots · Three-pointers'} />
        {source && !pose ? (
          notice ? <Panel><Notice>{notice}</Notice><Button label="Try again" kind="secondary" onPress={() => setAttempt((old) => old + 1)} /></Panel>
            : <Panel><Loading text="Opening your shot…" /></Panel>
        ) : <PoseComparison shotPose={pose} />}
      </Page>
    </>
  );
}

function PoseComparison({ shotPose }: { shotPose?: Pose }) {
  const [reference, setReference] = useState(preferred);
  const playerPose = shotPose ?? example.pose;
  const playerLabel = shotPose ? 'Your shot' : example.player;
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [angle, setAngle] = useState(0.55);
  const [openingAR, setOpeningAR] = useState(false);
  const [arNotice, setArNotice] = useState<string>();
  const opening = useRef(false);
  const startAngle = useRef(angle);
  const liveAngle = useRef(angle);
  const playhead = useRef(frame);
  const rotate = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, drag) => Math.abs(drag.dx) > 8 && Math.abs(drag.dx) > Math.abs(drag.dy),
    onPanResponderGrant: () => { startAngle.current = liveAngle.current; },
    onPanResponderMove: (_event, drag) => {
      liveAngle.current = startAngle.current + drag.dx * 0.018;
      setAngle(liveAngle.current);
    },
  }), []);

  useEffect(() => {
    if (!playing) return;
    // Slow motion makes the release easier to inspect in the 37-frame window.
    const started = performance.now() - playhead.current * 2000 / playerPose.fps;
    let animation: number;
    const tick = () => {
      const elapsed = Math.floor((performance.now() - started) * playerPose.fps / 2000);
      const next = elapsed % playerPose.frameCount;
      if (next !== playhead.current) {
        playhead.current = next;
        setFrame(next);
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playerPose.fps, playerPose.frameCount, playing]);

  function seek(next: number) {
    setPlaying(false);
    playhead.current = Math.round(next);
    setFrame(playhead.current);
  }

  function changeAngle(next: number) {
    liveAngle.current = next;
    setAngle(next);
  }

  async function openAR() {
    if (opening.current) return;
    opening.current = true;
    setOpeningAR(true);
    setArNotice(undefined);
    setPlaying(false);
    try {
      const asset = new File(Paths.cache, 'Peek Comparison.usdz');
      asset.write(comparisonUsdz(playerPose, reference.pose));
      await asset.preview({ title: 'Peek shot comparison' });
    } catch (error) {
      setArNotice(message(error, 'Could not open the comparison in AR.'));
    } finally {
      opening.current = false;
      setOpeningAR(false);
    }
  }

  const frameDeltaMs = Math.round((frame - playerPose.releaseIndex) * 1000 / playerPose.fps);
  const chosenReference = references.filter(({ player }) => !!shotPose || player !== example.player);

  return (
    <>
      <View style={styles.stageRow} {...rotate.panHandlers}>
        <PosePanel label={playerLabel} detail={shotPose ? handLabel(playerPose) : averageLabel(example)}
          pose={playerPose} frame={frame} angle={angle} tint={colors.white} />
        <PosePanel label={reference.player} detail={averageLabel(reference)}
          pose={reference.pose} frame={frame} angle={angle} tint="#ffca0a" />
      </View>
      <Button label={openingAR ? 'Opening AR…' : 'View in AR'} arrow onPress={openAR} disabled={openingAR} />
      {arNotice ? <Notice>{arNotice}</Notice> : null}
      <Panel style={styles.playback}>
        <View style={ui.row}>
          <Chip label={playing ? 'Pause' : 'Play at 0.5×'} onPress={() => setPlaying((value) => !value)} />
          <Text accessibilityLiveRegion={playing ? 'none' : 'polite'} style={ui.label}>
            {frameDeltaMs === 0 ? 'RELEASE' : (frameDeltaMs > 0 ? '+' : '−') + String(Math.abs(frameDeltaMs)) + ' MS FROM RELEASE'}
          </Text>
        </View>
        <Slider minimumValue={0} maximumValue={playerPose.frameCount - 1} step={1} value={frame} tapToSeek
          accessibilityLabel="Both shots' playhead" minimumTrackTintColor={colors.note}
          maximumTrackTintColor={colors.border} thumbTintColor={colors.note}
          onSlidingStart={() => setPlaying(false)} onValueChange={seek} />
        <View style={styles.angleControls}>
          <Chip label="Front view" selected={Math.abs(angle) < 0.03} onPress={() => changeAngle(0)} />
          <Chip label="Side view" selected={Math.abs(angle - Math.PI / 2) < 0.03} onPress={() => changeAngle(Math.PI / 2)} />
          <Text style={ui.body}>Drag to rotate</Text>
        </View>
      </Panel>
      <View style={styles.reference}>
        <Text accessibilityRole="header" style={ui.title}>NBA reference</Text>
        <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.players}>
          {chosenReference.map((item) => <Chip key={item.player} label={item.player} selected={item.player === reference.player} onPress={() => setReference(item)} />)}
        </ScrollView>
      </View>
      <Panel>
        <Text accessibilityRole="header" style={ui.title}>Shooting form</Text>
        <View style={styles.metricsRow}>
          <Text style={[ui.mono, styles.metricLabel]}>MEASUREMENT</Text>
          <Text style={[ui.label, styles.metric]} numberOfLines={1}>{playerLabel}</Text>
          <Text style={[ui.label, styles.metric]} numberOfLines={1}>{reference.player}</Text>
        </View>
        <Metric label="Elbow at release" left={playerPose.metrics.releaseElbowDeg}
          right={reference.pose.metrics.releaseElbowDeg} unit="°" />
        <Metric label="Knee at dip" left={playerPose.metrics.kneeDipDeg} right={reference.pose.metrics.kneeDipDeg} unit="°" />
        <Metric label="Wrist vs. head" left={playerPose.metrics.releaseHeight} right={reference.pose.metrics.releaseHeight} unit="×" />
        <Text style={ui.body}>Both shots are aligned at release and scaled to the same body height.</Text>
      </Panel>
    </>
  );
}

function handLabel(pose: Pose) {
  return pose.shootingHand === 'left' ? 'Left-handed' : 'Right-handed';
}

function averageLabel(reference: Reference) {
  return String(reference.shotsAveraged) + '-shot average';
}

function Metric({ label, left, right, unit }: { label: string; left: PoseSample; right: PoseSample; unit: '°' | '×' }) {
  const display = (value: PoseSample) => value === null || !Number.isFinite(value) ? '—'
    : (unit === '°' ? String(Math.round(value)) : value.toFixed(2)) + unit;
  return (
    <View style={styles.metricsRow}>
      <Text style={[ui.text, styles.metricLabel]}>{label}</Text>
      <Text style={[ui.time, styles.metric]}>{display(left)}</Text>
      <Text style={[ui.time, styles.metric]}>{display(right)}</Text>
    </View>
  );
}

type Point = [number, number];
function PosePanel({ label, detail, pose, frame, angle, tint }: {
  label: string; detail: string; pose: Pose; frame: number; angle: number; tint: string;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ground = useMemo(() => poseGround(pose), [pose]);

  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const scale = Math.min(size.width * 1.07, size.height * 0.54);
  const floor = size.height * 0.92;
  const pelvisRise = pose.pelvisRise?.[frame] ?? 0;
  const offset = frame * coordinatesPerFrame;
  const joints = Array.from({ length: jointCount }, (_, index): Point | null => {
    const start = offset + index * 3;
    const [x, y, z] = pose.joints.slice(start, start + 3);
    if (x == null || y == null || z == null) return null;
    const horizontal = cos * x + sin * z;
    const depth = cos * z - sin * x;
    const perspective = 3.5 / Math.max(2, 3.5 + depth);
    return [size.width * 0.5 + horizontal * scale * perspective, floor + (y - pelvisRise - ground) * scale * perspective];
  });

  return (
    <LinearGradient colors={gradients.media} style={styles.stage}>
      <Text style={styles.stageName} numberOfLines={2}>{label}</Text>
      <Text style={ui.mono}>{detail}</Text>
      <View style={styles.figure} accessible accessibilityLabel={label + ' animated three-dimensional skeleton'}
        onLayout={({ nativeEvent: { layout } }) => setSize({ width: layout.width, height: layout.height })}>
        <View pointerEvents="none" style={[styles.floor, { top: floor }]} />
        {size.height > 0 ? (
          <>
            {bones.map(([from, to]) => {
              const a = joints[from], b = joints[to];
              if (!a || !b) return null;
              const dx = b[0] - a[0], dy = b[1] - a[1];
              const width = Math.hypot(dx, dy);
              return <View key={from + '-' + to} style={[styles.bone, {
                width, backgroundColor: tint, left: (a[0] + b[0] - width) / 2, top: (a[1] + b[1] - 3) / 2,
                transform: [{ rotate: String(Math.atan2(dy, dx)) + 'rad' }],
              }]} />;
            })}
            {joints.map((point, index) => {
              if (!point) return null;
              const radius = index === 10 ? 6 : 2.5;
              return <View key={index} style={{
                position: 'absolute', left: point[0] - radius, top: point[1] - radius,
                width: 2 * radius, height: 2 * radius, borderRadius: radius, backgroundColor: tint,
              }} />;
            })}
          </>
        ) : null}
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  stageRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  stage: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: 10, gap: 3, minWidth: 0, overflow: 'hidden' },
  stageName: { ...ui.title, fontSize: 14, lineHeight: 18, minHeight: 36, textAlignVertical: 'center' },
  figure: { height: 183, borderRadius: 12, overflow: 'hidden' },
  floor: { height: 1, backgroundColor: colors.border, position: 'absolute', left: 7, right: 7 },
  bone: { position: 'absolute', height: 3, borderRadius: 1.5 },
  playback: { gap: 8 },
  angleControls: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  reference: { gap: 7 },
  players: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 12 },
  metricsRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metricLabel: { flex: 1.18 },
  metric: { flex: 1, textAlign: 'right' },
});
