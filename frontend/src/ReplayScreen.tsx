import Slider from '@react-native-community/slider';
import { useEvent } from 'expo';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PracticeStore } from './database';
import { localVideoUri, recordingFiles } from './device-storage';
import { clipTime, DRILL_NAME, sessionTime, shotStats } from './practice';
import type { Session, Shot, ShotOutcome } from './practice';
import { removeRecording } from './recordings';
import { ShotAnalysisPanel } from './ShotAnalysisPanel';
import {
  Button, colors, fonts, gradients, Icon, IconButton, Loading, message, Notice, Page, Panel,
  ScreenHeader, Sheet, StatsGrid, Title, ui,
} from './ui';

const outcomes: { value: ShotOutcome; label: string }[] = [
  { value: 'made', label: 'Made' }, { value: 'missed', label: 'Missed' }, { value: 'unmarked', label: 'Unmarked' },
];

type Stats = ReturnType<typeof shotStats>;

export function ReplayScreen({ initialSession, store, cloudUserId, playerUserId, onShotsChanged, backLabel, onBack, onAskCoach, onCompare }: {
  initialSession: Session;
  store: PracticeStore;
  cloudUserId: string | null;
  playerUserId: string | null;
  onShotsChanged: () => void;
  backLabel: string;
  onBack: () => void;
  onAskCoach: (session: Session) => void;
  onCompare: (shotNumber: number) => void;
}) {
  const [session, setSession] = useState(initialSession);
  const [shots, setShots] = useState(() => store.listShots(session.id));
  const [choosingShot, setChoosingShot] = useState(false);
  const [edit, setEdit] = useState<Shot>();
  const [removing, setRemoving] = useState(false);
  const [editorError, setEditorError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const video = localVideoUri(session.videoPath);
  const stats = shotStats(shots);
  const cloudShotCount = cloudUserId ? store.sessionCloudShots(cloudUserId, session.id).length : 0;
  const onlyShot = shots.length === 1 ? shots[0] : undefined;

  function tag(releaseMs: number, outcome: ShotOutcome, existing?: Shot) {
    setEditorError(undefined);
    setNotice(undefined);
    try {
      if (existing) store.updateShot(session.id, existing.shotNumber, outcome, cloudUserId);
      else store.addShot(session.id, releaseMs, outcome, playerUserId);
    } catch (error) {
      const text = message(error, 'Your shot tag could not be saved.');
      if (edit) setEditorError(text);
      else setNotice(text);
      return;
    }
    setEdit(undefined);
    setShots(store.listShots(session.id));
    onShotsChanged();
  }

  function confirmRemove() {
    try {
      removeRecording(session, recordingFiles, store);
      setSession({ ...session, videoPath: null });
      setNotice(undefined);
      onShotsChanged();
    } catch {
      setNotice('The video removal could not be completed. You can retry.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <ScreenHeader backLabel={backLabel} detail="ON THIS IPHONE" onBack={onBack} />
      <Page style={styles.page}>
        <Title title="Session details" subtitle={DRILL_NAME} />
        <Button label={onlyShot ? `Compare shot ${onlyShot.shotNumber} vs NBA` : 'Compare your shot vs NBA'} arrow
          onPress={() => onlyShot ? onCompare(onlyShot.shotNumber) : setChoosingShot(true)} />
        {video ? (
          <ReplayPlayer uri={video} durationMs={session.durationMs} stats={stats} shots={shots} onTag={tag} />
        ) : (
          <MediaFrame>
            <Icon name="clipOff" />
            <Text style={ui.mono}>Video removed</Text>
          </MediaFrame>
        )}
        {notice ? <Notice>{notice}</Notice> : null}
        <Panel>
          <View style={ui.row}>
            <Text style={styles.panelLabel}>SHOOTING STATS</Text>
            <Text style={ui.label}>{sessionTime(session.createdAt).toUpperCase()}</Text>
          </View>
          <StatsGrid stats={stats} showFg />
          <Text style={styles.explainer}>FG% uses shots marked made or missed.</Text>
        </Panel>
        {!video ? <Text style={ui.serif}>Your shot stats are still saved on this iPhone.</Text> : null}
        {video || cloudShotCount ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Ask Coach about this session"
            onPress={() => onAskCoach(session)} style={({ pressed }) => pressed ? styles.dimmed : undefined}>
            <LinearGradient colors={gradients.media} style={styles.coachCard}>
              <Icon name="pulse" />
              <View style={styles.coachDetails}>
                <Text style={ui.label}>ASK COACH</Text>
                <Text style={styles.coachText}>Get tips to improve the shot in this clip  →</Text>
              </View>
            </LinearGradient>
          </Pressable>
        ) : null}
        {session.videoPath ? <Button label="Remove video" kind="secondary" icon="trash" onPress={() => setRemoving(true)} /> : null}
        {shots.length ? (
          <Panel>
            <Text style={styles.panelLabel}>TAGGED SHOTS</Text>
            {shots.map((shot) => (
              <View key={shot.shotNumber} style={ui.group}>
                <Pressable accessibilityRole="button"
                  accessibilityLabel={'Edit shot ' + String(shot.shotNumber) + ', ' + shot.outcome + ', at ' + clipTime(shot.releaseMs, true)}
                  onPress={() => { setEditorError(undefined); setEdit(shot); }}
                  style={({ pressed }) => [styles.shotRow, pressed && styles.dimmed]}>
                  <View style={ui.group}>
                    <Text style={ui.text}>Shot {shot.shotNumber}</Text>
                    <Text style={ui.time}>{clipTime(shot.releaseMs, true)}</Text>
                  </View>
                  <View style={styles.shotEnd}>
                    <Text style={ui.body}>{outcomes.find(({ value }) => value === shot.outcome)?.label}</Text>
                    <Icon name="chevron" />
                  </View>
                </Pressable>
                <Button label={`Compare shot ${shot.shotNumber}`} kind="secondary" arrow onPress={() => onCompare(shot.shotNumber)} />
              </View>
            ))}
          </Panel>
        ) : null}
        {cloudUserId && cloudShotCount > 0 ? (
          <ShotAnalysisPanel key={cloudUserId + ':' + session.id} store={store} sessionId={session.id}
            userId={cloudUserId} shotCount={cloudShotCount} onCompare={onCompare} />
        ) : null}
      </Page>
      <Sheet visible={choosingShot} onClose={() => setChoosingShot(false)}>
        {shots.length ? (
          <>
            <Title title="Choose a shot" size={26} />
            <ScrollView style={styles.shotPicker} contentContainerStyle={styles.shotPickerList}>
              {shots.map(({ shotNumber, releaseMs }) => (
                <Button key={shotNumber} label={`Shot ${shotNumber} · ${clipTime(releaseMs, true)}`} kind="secondary" arrow
                  onPress={() => {
                    setChoosingShot(false);
                    onCompare(shotNumber);
                  }} />
              ))}
            </ScrollView>
            <Button label="Cancel" kind="secondary" onPress={() => setChoosingShot(false)} />
          </>
        ) : (
          <>
            <Title title="Tag a shot first" size={26} />
            <Text style={ui.body}>{video
              ? 'Pause when the ball leaves your hand. Tap Made, Missed, or Unmarked to tag the shot.'
              : 'Open a saved recording to tag a shot and compare it.'}</Text>
            <Button label={video ? 'Back to video' : 'Back to session'} onPress={() => setChoosingShot(false)} />
          </>
        )}
      </Sheet>
      <Sheet visible={removing} onClose={() => setRemoving(false)}>
        <Title title="Remove video?" size={33} />
        <Text style={ui.body}>This frees space on your iPhone. Your shot stats will stay in Saved Clips.</Text>
        <View style={styles.sheetActions}>
          <Button label="Keep video" kind="secondary" icon="check" style={styles.equal} onPress={() => setRemoving(false)} />
          <Button label="Remove video" kind="danger" icon="trash" style={styles.equal} onPress={confirmRemove} />
        </View>
      </Sheet>
      <Sheet visible={!!edit} onClose={() => setEdit(undefined)}>
        <Title title="Edit shot" size={32} />
        {edit ? <Text style={ui.serif}>Release at {clipTime(edit.releaseMs, true)}</Text> : null}
        {editorError ? <Notice>{editorError}</Notice> : null}
        {edit ? (
          <View style={styles.sheetActions}>
            {outcomes.map(({ value, label }) => (
              <Button key={value} label={label} kind="secondary" style={styles.equal}
                selected={edit.outcome === value} onPress={() => tag(edit.releaseMs, value, edit)} />
            ))}
          </View>
        ) : null}
        <Button label="Cancel" kind="secondary" onPress={() => setEdit(undefined)} />
      </Sheet>
    </>
  );
}

function MediaFrame({ children, duration }: React.PropsWithChildren<{ duration?: number }>) {
  return (
    <LinearGradient colors={gradients.media} style={styles.player}>
      {children}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={[styles.corner, styles.topLeft]} />
        <View style={[styles.corner, styles.topRight]} />
        <View style={[styles.corner, styles.bottomLeft]} />
        <View style={[styles.corner, styles.bottomRight]} />
      </View>
      {duration !== undefined ? <Text pointerEvents="none" style={styles.duration}>{clipTime(duration)}</Text> : null}
    </LinearGradient>
  );
}

type PlayerProps = {
  uri: string;
  durationMs: number;
  stats: Stats;
  shots: Shot[];
  onTag: (ms: number, outcome: ShotOutcome, existing?: Shot) => void;
};

function ReplayPlayer(props: PlayerProps) {
  const [attempt, setAttempt] = useState(0);
  return <ClipPlayer key={attempt} {...props} onRetry={() => setAttempt(attempt + 1)} />;
}

function ClipPlayer({ uri, durationMs, stats, shots, onTag, onRetry }: PlayerProps & { onRetry: () => void }) {
  const player = useVideoPlayer(uri, (item) => {
    item.timeUpdateEventInterval = 0.1;
    item.seekTolerance = { toleranceBefore: 0, toleranceAfter: 0 };
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const time = useEvent(player, 'timeUpdate');
  const dragging = useRef(false);
  const [scrub, setScrub] = useState<number>();
  const [seekTarget, setSeekTarget] = useState<number>();
  const [slow, setSlow] = useState(false);
  const duration = player.duration || durationMs / 1000;
  const elapsed = Math.min(duration, scrub ?? seekTarget ?? time?.currentTime ?? player.currentTime);
  const ready = status === 'readyToPlay';
  const nearbyShot = closestShot(shots, elapsed * 1000);

  function seek(seconds: number) {
    player.pause();
    player.currentTime = seconds;
    setSeekTarget(seconds);
    setScrub(undefined);
  }

  function playOrPause() {
    if (player.playing) {
      player.pause();
      return;
    }
    const nextPosition = seekTarget ?? player.currentTime;
    setSeekTarget(undefined);
    if (nextPosition >= duration - 0.05) player.replay();
    else player.play();
    player.playbackRate = slow ? 0.5 : 1;
  }

  if (status === 'error') {
    return <Panel><Notice>The saved video could not be played.</Notice><Button label="Retry playback" kind="secondary" onPress={onRetry} /></Panel>;
  }

  return (
    <View style={styles.playback}>
      <MediaFrame duration={durationMs}>
        <VideoView accessible={false} style={StyleSheet.absoluteFill} player={player} nativeControls={false} contentFit="contain" />
        {ready ? null : <Loading text="Opening clip…" />}
      </MediaFrame>
      <View style={styles.controls}>
        {isPlaying ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Pause" onPress={playOrPause} style={styles.control}>
            <View style={styles.pause}><View style={styles.pauseBar} /><View style={styles.pauseBar} /></View>
          </Pressable>
        ) : <IconButton icon="play" label="Play" onPress={playOrPause} style={styles.control} disabled={!ready} />}
        <Text style={styles.timeline}>{clipTime(elapsed * 1000)} / {clipTime(durationMs)}</Text>
        {[0.5, 1].map((rate) => (
          <Pressable key={rate} accessibilityRole="button" accessibilityLabel={String(rate) + '× speed'}
            accessibilityState={{ selected: slow === (rate === 0.5), disabled: !ready }} disabled={!ready}
            style={[styles.control, slow === (rate === 0.5) && styles.speedActive]}
            onPress={() => { player.playbackRate = rate; setSlow(rate === 0.5); }}>
            <Text style={ui.time}>{rate}×</Text>
          </Pressable>
        ))}
      </View>
      <Slider accessibilityLabel="Video playhead"
        accessibilityValue={{ text: clipTime(elapsed * 1000, true) + ' of ' + clipTime(durationMs, true) }}
        disabled={!ready} minimumValue={0} maximumValue={duration} value={elapsed} tapToSeek
        minimumTrackTintColor={colors.note} maximumTrackTintColor={colors.border} thumbTintColor={colors.note}
        style={styles.scrubber}
        onSlidingStart={(seconds) => {
          dragging.current = true;
          player.pause();
          setScrub(seconds);
        }}
        onValueChange={(seconds) => {
          if (dragging.current) setScrub(seconds);
          else seek(seconds);
        }}
        onSlidingComplete={(seconds) => {
          dragging.current = false;
          seek(seconds);
        }}
      />
      <Panel style={styles.marking}>
        <View style={ui.row}>
          <Text style={ui.label}>YOUR SHOT · {clipTime(elapsed * 1000)}</Text>
          <Text style={ui.mono}>{stats.percentage === null ? '—' : String(stats.percentage) + '%'} · {stats.makes} OF {stats.attempts}</Text>
        </View>
        <Text style={ui.body}>Mark this shot yourself:</Text>
        <View style={styles.outcomes}>
          {outcomes.map(({ value, label }) => (
            <Button key={value} label={label} kind="secondary" selected={nearbyShot?.outcome === value}
              disabled={!ready || scrub !== undefined} style={styles.outcome}
              onPress={() => {
                player.pause();
                const releaseMs = Math.min(durationMs, Math.round(Math.max(0, seekTarget ?? player.currentTime) * 1000));
                onTag(releaseMs, value, closestShot(shots, releaseMs));
              }} />
          ))}
        </View>
      </Panel>
    </View>
  );
}

function closestShot(shots: Shot[], releaseMs: number) {
  let selected: Shot | undefined;
  let distance = 120;
  for (const shot of shots) {
    const gap = Math.abs(shot.releaseMs - releaseMs);
    if (gap < distance) {
      distance = gap;
      selected = shot;
    }
  }
  return selected;
}

const styles = StyleSheet.create({
  page: { gap: 16 },
  playback: { gap: 11 },
  player: { aspectRatio: 16 / 9.85, borderRadius: 24, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', gap: 9 },
  corner: { position: 'absolute', width: 15, height: 15, borderColor: colors.border },
  topLeft: { top: 12, left: 12, borderTopWidth: 1, borderLeftWidth: 1 },
  topRight: { top: 12, right: 12, borderTopWidth: 1, borderRightWidth: 1 },
  bottomLeft: { bottom: 12, left: 12, borderBottomWidth: 1, borderLeftWidth: 1 },
  bottomRight: { bottom: 12, right: 12, borderBottomWidth: 1, borderRightWidth: 1 },
  duration: { ...ui.label, fontSize: 10, position: 'absolute', top: 12, right: 13, backgroundColor: colors.media, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  scrubber: { height: 32, marginHorizontal: -2 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  control: { minWidth: 46, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: '#252023' },
  speedActive: { backgroundColor: '#552333' },
  timeline: { ...ui.time, paddingLeft: 6, flex: 1 },
  pause: { flexDirection: 'row', gap: 3 },
  pauseBar: { height: 12, width: 2, backgroundColor: colors.text },
  marking: { paddingVertical: 12 },
  outcomes: { flexDirection: 'row', gap: 5 },
  outcome: { flex: 1, paddingHorizontal: 5, minHeight: 44, justifyContent: 'center', borderRadius: 18 },
  panelLabel: { ...ui.mono, color: colors.text },
  explainer: { ...ui.serif, fontSize: 13, lineHeight: 18 },
  coachCard: { padding: 13, borderRadius: 20, flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  coachDetails: { gap: 4, flex: 1 },
  coachText: { color: colors.text, fontFamily: fonts.serifBold, fontSize: 14, lineHeight: 17, maxWidth: 210 },
  shotRow: { ...ui.row, minHeight: 52, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },
  shotEnd: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  shotPicker: { maxHeight: 310 },
  shotPickerList: { gap: 8 },
  dimmed: { opacity: 0.65 },
  sheetActions: { flexDirection: 'row', gap: 10, marginTop: 5 },
  equal: { flex: 1 },
});
