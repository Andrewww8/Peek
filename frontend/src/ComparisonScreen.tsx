import Slider from '@react-native-community/slider';
import { Asset } from 'expo-asset';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, PanResponder, ScrollView, StyleSheet, Text, View } from 'react-native';

import { accountFetch, apiUrl } from './api';
import { accessToken } from './auth';
import { cloudIssueText } from './cloud-issue';
import type { PracticeStore } from './database';
import { localVideoUri } from './device-storage';
import { getShotAnalysisState, hasOnDeviceAnalysis, needsShotAnalysisRefresh, startShotAnalysis, subscribeToShotAnalysis, type ShotAnalysisTag } from './guest-pose';
import { bones, comparisonPlayback, comparisonUsdz, coordinatesPerFrame, jointCount, poseGround, posePointCount, shotMotionWindow, stabilizedShotPlayback, visiblePosePoint } from './pose-3d';
import type { NameAtlas, Pose, PoseSample } from './pose-3d';
import { clipTime } from './practice';
import { ShotAnalysisProgress } from './ShotAnalysisProgress';
import { Button, Chip, colors, gradients, Loading, message, Notice, Page, Panel, ScreenHeader, Sheet, Title, ui } from './ui';

type Reference = { player: string; shotsAveraged: number; pose: Pose };
export type ComparisonShot = { sessionId: string; shotNumber?: number };
type TaggedComparisonShot = Required<ComparisonShot>;
type Navigation = { backLabel: string; onBack: () => void };

const references: Reference[] = require('../assets/peek-nba-poses.json');
const nameAtlas: NameAtlas = require('../assets/peek-ar-name-atlas.json');
const nameAtlasImage: number = require('../assets/peek-ar-name-atlas.png');
const preferred = references.find(({ player }) => player === 'Stephen Curry') ?? references[0]!;

let nameAtlasBytes: Promise<Uint8Array> | undefined;

async function loadNameAtlas() {
  return nameAtlasBytes ??= Asset.fromModule(nameAtlasImage).downloadAsync().then(({ localUri }) => {
    if (!localUri) throw new Error('The comparison labels could not be opened.');
    return new File(localUri).bytes();
  }).catch((error) => {
    nameAtlasBytes = undefined;
    throw error;
  });
}

async function loadShotPose(shot: TaggedComparisonShot, userId: string, syncing: boolean, signal: AbortSignal): Promise<Pose | string> {
  const { sessionId, shotNumber } = shot;
  const request = accountFetch(apiUrl, (renew) => accessToken(userId, renew));
  const response = await request('/v1/sessions/' + encodeURIComponent(sessionId) + '/shots/' + String(shotNumber) + '/pose?followThrough=1', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  const body = await response.json() as { pose?: Pose; shotType?: string; message?: string };
  if (response.status === 404 && syncing) return 'Syncing your shot…';
  if (response.status === 409) return 'Waiting for shot analysis…';
  if (!response.ok) throw new Error(body.message || 'Could not load the 3D pose.');
  const pose = body.pose;
  if (body.shotType !== 'three_point' || !pose || pose.fps !== preferred.pose.fps ||
      pose.releaseIndex !== preferred.pose.releaseIndex || pose.frameCount <= pose.releaseIndex ||
      !Array.isArray(pose.joints) || pose.joints.length !== pose.frameCount * coordinatesPerFrame) {
    throw new Error('This shot could not be lined up with the three-point reference.');
  }
  return pose;
}

type ComparisonProps = Navigation & {
  shot: ComparisonShot;
  store: PracticeStore;
  userId: string | null;
  isGuest: boolean;
  playerName?: string;
  guestLimit?: string;
  onChooseShot: () => void;
  onSignIn: () => void;
  onGuestConnect: () => Promise<string>;
  onSync: () => void;
};

export function ComparisonScreen(props: ComparisonProps) {
  const { shot: { sessionId, shotNumber }, store } = props;
  const video = localVideoUri(store.getSession(sessionId)?.videoPath ?? null) ?? undefined;
  if (shotNumber === undefined) return <OnDeviceComparisonScreen {...props} video={video} />;
  if (props.isGuest && hasOnDeviceAnalysis()) {
    const tag = store.listShots(sessionId).find((item) => item.shotNumber === shotNumber);
    if (tag && (video || getShotAnalysisState(sessionId, tag)?.result || !props.userId)) {
      return <OnDeviceComparisonScreen {...props} tag={tag} video={video} />;
    }
  }
  return <CloudComparisonScreen {...props} shot={{ sessionId, shotNumber }} />;
}

function OnDeviceComparisonScreen({ shot, tag, video, isGuest, playerName, backLabel, onBack, onChooseShot }: ComparisonProps & {
  video?: string;
  tag?: ShotAnalysisTag;
}) {
  const { sessionId } = shot;
  const state = useSyncExternalStore(subscribeToShotAnalysis, () => getShotAnalysisState(sessionId, tag));
  const result = state?.result;
  const updatingPose = state?.phase === 'queued' || state?.phase === 'detecting' || state?.phase === 'tracking';
  const automatic = shot.shotNumber === undefined;
  const refreshStarted = useRef<string>(undefined);

  useEffect(() => {
    if (!video) return;
    if (automatic && !state) {
      void startShotAnalysis(sessionId, video, undefined, isGuest).catch(() => undefined);
    } else if (state?.phase === 'complete' && state.result && needsShotAnalysisRefresh(state.result)) {
      const key = sessionId + ':' + (tag ? tag.shotNumber + ':' + tag.releaseMs : 'auto');
      if (refreshStarted.current === key) return;
      refreshStarted.current = key;
      void startShotAnalysis(sessionId, video, tag, isGuest).catch(() => undefined);
    }
  }, [automatic, video, state, sessionId, tag, isGuest]);

  function analyze() {
    if (video) void startShotAnalysis(sessionId, video, tag, isGuest).catch(() => undefined);
  }
  const releaseTime = result ? ` · Release ${automatic ? '≈ ' : ''}${clipTime(result.releaseMs, true)}` : '';

  return (
    <>
      <ScreenHeader backLabel={backLabel} detail="3D COMPARISON" onBack={onBack} />
      <Page>
        <Title title="Your shot vs NBA" subtitle={`${automatic ? 'Catch-and-shoot three' : 'Shot ' + shot.shotNumber}${releaseTime}`} />
        {result ? (
          <>
            {state?.phase !== 'complete' ? <ShotAnalysisProgress sessionId={sessionId} tag={tag} /> : null}
            <PoseComparison key={sessionId + ':' + (tag ? `${tag.shotNumber}:${tag.releaseMs}` : 'auto')} playerPose={result.pose}
              playerLabel={playerName ?? 'Your shot'} updatingPose={updatingPose} />
          </>
        ) : (
          <Panel>
            <ShotAnalysisProgress sessionId={sessionId} tag={tag} />
            {video ? (
              !state || state.phase === 'failed' ? <Button label={state ? 'Try again' : automatic ? 'Find the release' : 'Analyze as guest'}
                onPress={analyze} /> : null
            ) : <Notice>This shot needs its original recording or a saved analysis.</Notice>}
          </Panel>
        )}
        <Button label="Back to session" kind="secondary" arrow onPress={onChooseShot} />
      </Page>
    </>
  );
}

function CloudComparisonScreen({ shot, store, userId, playerName, guestLimit, backLabel, onBack, onChooseShot, onSignIn, onGuestConnect, onSync }: ComparisonProps & { shot: TaggedComparisonShot }) {
  const [loaded, setLoaded] = useState<{ userId: string; pose: Pose }>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState('Opening your shot…');
  const [connecting, setConnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { sessionId, shotNumber } = shot;
  const cloudShot = userId ? store.sessionCloudShots(userId, sessionId).find((item) => item.shotNumber === shotNumber) : undefined;
  const state = cloudShot?.state;
  const queued = !!state && state !== 'unavailable';
  const limitNotice = state === 'pending' ? guestLimit : undefined;
  const pose = loaded?.userId === userId ? loaded.pose : undefined;
  const canAnalyze = !!localVideoUri(store.getSession(sessionId)?.videoPath ?? null);

  useEffect(() => {
    if (!userId || !queued || limitNotice) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setNotice(undefined);
    setLoaded(undefined);
    setLoading('Opening your shot…');
    const load = async () => {
      if (signal.aborted) return;
      if (AppState.currentState === 'background') {
        timer = setTimeout(load, 8_000);
        return;
      }
      try {
        const current = store.sessionCloudShots(userId, sessionId).find((item) => item.shotNumber === shotNumber);
        if (current?.state === 'unavailable') throw new Error(cloudIssueText(current.issue));
        const result = await loadShotPose({ sessionId, shotNumber }, userId, current?.state === 'pending', signal);
        if (signal.aborted) return;
        if (typeof result === 'string') {
          setLoading(result);
          timer = setTimeout(load, 8_000);
        } else setLoaded({ userId, pose: result });
      } catch (error) {
        if (!signal.aborted) setNotice(message(error, 'The 3D pose could not be loaded.'));
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [store, sessionId, shotNumber, userId, queued, attempt, limitNotice]);

  async function analyze() {
    if (connecting) return;
    setNotice(undefined);
    setConnecting(true);
    try {
      const owner = userId ?? await onGuestConnect();
      store.prepareAnalysis(sessionId, owner, shotNumber);
      onSync();
      setAttempt((value) => value + 1);
    } catch (error) {
      setNotice(message(error, 'The shot could not be queued for analysis.'));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <>
      <ScreenHeader backLabel={backLabel} detail="3D COMPARISON" onBack={onBack} />
      <Page>
        <Title title="Your shot vs NBA" subtitle={`Shot ${shotNumber} · Catch-and-shoot three`} />
        {!userId ? (
          <Panel>
            {notice ? <Notice>{notice}</Notice> : null}
            {canAnalyze ? (
              <>
                <Text style={ui.body}>Send this recording for shot analysis.</Text>
                <Button label={connecting ? 'Connecting…' : 'Analyze as guest'} onPress={() => void analyze()} disabled={connecting} />
              </>
            ) : <Text style={ui.body}>Sign in to open a completed analysis.</Text>}
            <Button label="Sign in" kind="secondary" onPress={onSignIn} disabled={connecting} />
          </Panel>
        ) : pose ? (
          <PoseComparison playerPose={pose} playerLabel={playerName ?? 'Your shot'} />
        ) : queued ? (
          <Panel>{limitNotice ? <Notice>{limitNotice}</Notice>
            : notice ? <><Notice>{notice}</Notice><Button label="Try again" kind="secondary" onPress={() => setAttempt((value) => value + 1)} /></>
              : <Loading text={loading} />}</Panel>
        ) : (
          <Panel>
            {notice && state !== 'unavailable' ? <Notice>{notice}</Notice> : null}
            {canAnalyze && state !== 'unavailable' ? (
              <><Text style={ui.body}>Send this recording for shot analysis to create your 3D comparison.</Text>
                <Button label={connecting ? 'Preparing shot…' : 'Analyze this shot'} onPress={() => void analyze()} disabled={connecting} /></>
            ) : <Notice>{state === 'unavailable' ? cloudIssueText(cloudShot?.issue) : 'Choose a shot with its original recording or a completed analysis.'}</Notice>}
          </Panel>
        )}
        <Button label="Choose another shot" kind="secondary" arrow onPress={onChooseShot} />
      </Page>
    </>
  );
}

function PoseComparison({ playerPose: fullPose, playerLabel, updatingPose = false }: {
  playerPose: Pose; playerLabel: string; updatingPose?: boolean;
}) {
  const [reference, setReference] = useState(preferred);
  const [firstFrame, lastMotionFrame] = useMemo(() => shotMotionWindow(fullPose), [fullPose]);
  const playerPose = useMemo(() => stabilizedShotPlayback(fullPose, firstFrame), [fullPose, firstFrame]);
  const referencePose = useMemo(() => comparisonPlayback(reference.pose, firstFrame), [reference, firstFrame]);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(playerPose.frameCount > 1);
  const [angle, setAngle] = useState(0.55);
  const [arRequested, setARRequested] = useState(false);
  const [arNotice, setArNotice] = useState<string>();
  const [picker, setPicker] = useState(false);
  const requested = useRef(false);
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

  useLayoutEffect(() => {
    playhead.current = 0;
    setFrame(0);
    setPlaying(playerPose.frameCount > 1);
  }, [playerPose]);

  useEffect(() => {
    if (!playing) return;
    // Play both shots at half speed on the same release-aligned timeline.
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
  }, [playerPose, playing]);

  useEffect(() => {
    void loadNameAtlas().catch(() => { /* The request can try again if warming the atlas fails. */ });
  }, []);

  useEffect(() => {
    if (!arRequested || updatingPose) return;
    const request = new AbortController();
    const { signal } = request;
    async function prepareAndOpen() {
      let staging: File | undefined;
      let preview: File | undefined;
      let opened = false;
      try {
        const png = await loadNameAtlas();
        if (signal.aborted) return;
        const bytes = comparisonUsdz(playerPose, referencePose, { atlas: nameAtlas, png, player: playerLabel, reference: reference.player });
        const cache = new Directory(Paths.cache, 'peek-ar');
        cache.create({ idempotent: true, intermediates: true });
        const name = 'peek-comparison-' + randomUUID();
        staging = new File(cache, name + '.partial');
        staging.create();
        await staging.write(bytes);
        if (signal.aborted) return;
        if (staging.size !== bytes.length) throw new Error('The AR comparison could not be saved.');
        preview = new File(cache, name + '.usdz');
        await staging.move(preview);
        staging = undefined;
        if (signal.aborted) return;
        let ready = await preview.canPreview();
        if (signal.aborted) return;
        if (!ready) {
          // Give a cold Quick Look check one more chance after the file is published.
          await new Promise<void>((resolve) => {
            const settle = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', settle);
              resolve();
            };
            const timer = setTimeout(settle, 135);
            signal.addEventListener('abort', settle, { once: true });
          });
          if (signal.aborted) return;
          ready = await preview.canPreview();
          if (signal.aborted) return;
        }
        if (!ready) throw new Error('Quick Look could not open this AR comparison.');
        await preview.preview({ title: playerLabel + ' vs. ' + reference.player });
        opened = true;
      } catch (error) {
        if (!signal.aborted) setArNotice(message(error, 'Could not open the comparison in AR.'));
      } finally {
        for (const file of [staging, opened ? undefined : preview]) {
          try { if (file?.exists) file.delete(); } catch { /* iOS can clear the preview cache. */ }
        }
        if (!signal.aborted) {
          requested.current = false;
          setARRequested(false);
        }
      }
    }
    void prepareAndOpen();
    return () => request.abort();
  }, [arRequested, playerLabel, playerPose, reference.player, referencePose, updatingPose]);

  function seek(next: number) {
    setPlaying(false);
    playhead.current = Math.round(next);
    setFrame(playhead.current);
  }

  function changeAngle(next: number) {
    liveAngle.current = next;
    setAngle(next);
  }

  function openAR() {
    if (requested.current) return;
    requested.current = true;
    setArNotice(undefined);
    setARRequested(true);
  }

  const frameDeltaMs = Math.round((frame - playerPose.releaseIndex) * 1000 / playerPose.fps);
  return (
    <>
      <View style={styles.stageRow} {...rotate.panHandlers}>
        <PosePanel label={playerLabel} detail={handLabel(playerPose)}
          pose={playerPose} frame={frame} angle={angle} tint={colors.white} />
        <PosePanel label={reference.player} detail={averageLabel(reference)}
          pose={referencePose} frame={frame} angle={angle} tint="#ffca0a" />
      </View>
      <View style={styles.stageActions}>
        <Button label={arRequested ? 'Preparing AR…' : 'View in AR'} arrow onPress={openAR} disabled={arRequested} style={styles.action} />
        <Button label="Change NBA player" kind="secondary" onPress={() => setPicker(true)} disabled={arRequested} style={styles.action} />
      </View>
      {arNotice ? <Notice>{arNotice}</Notice> : null}
      {firstFrame === lastMotionFrame ? (
        <Notice>Only a still pose was tracked near this tag. Tag the ball release in a clip with the shooter in view to see motion.</Notice>
      ) : null}
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
      <Sheet visible={picker} onClose={() => setPicker(false)}>
        <Title title="Change NBA player" size={26} />
        <ScrollView style={styles.pickerList} contentContainerStyle={styles.players}>
          {references.map((item) => (
            <Button key={item.player} label={item.player} kind="secondary"
              icon={item.player === reference.player ? 'check' : undefined}
              selected={item.player === reference.player} onPress={() => {
                setReference(item);
                setArNotice(undefined);
                setPicker(false);
              }} />
          ))}
        </ScrollView>
        <Button label="Cancel" kind="secondary" onPress={() => setPicker(false)} />
      </Sheet>
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
  const joints = Array.from({ length: posePointCount }, (_, index): Point | null => {
    const point = visiblePosePoint(pose, frame, index);
    if (!point) return null;
    const [x, y, z] = point;
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
              const thickness = to >= jointCount ? 1 : 3;
              return <View key={from + '-' + to} style={[styles.bone, {
                width, height: thickness, backgroundColor: tint, left: (a[0] + b[0] - width) / 2, top: (a[1] + b[1] - thickness) / 2,
                transform: [{ rotate: String(Math.atan2(dy, dx)) + 'rad' }],
              }]} />;
            })}
            {joints.map((point, index) => {
              if (!point) return null;
              const wrist = index === 13 || index === 16;
              const radius = index >= jointCount ? index < jointCount + 4 ? 1.2 : 0.8 : index === 10 ? 6 : wrist ? 2.65 : 2.5;
              return <View key={index} style={{
                position: 'absolute', left: point[0] - radius, top: point[1] - radius,
                width: 2 * radius, height: 2 * radius, borderRadius: radius,
                backgroundColor: wrist ? 'transparent' : tint, borderColor: tint, borderWidth: wrist ? 1.15 : 0,
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
  stageActions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
  angleControls: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  pickerList: { maxHeight: 310 },
  players: { gap: 8 },
  metricsRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metricLabel: { flex: 1.18 },
  metric: { flex: 1, textAlign: 'right' },
});
