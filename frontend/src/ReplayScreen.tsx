import Slider from '@react-native-community/slider';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { PracticeStore } from './database';
import { localVideoUri, recordingFiles } from './device-storage';
import { clipTime, DRILL_NAME, PRACTICE_TIP, sessionDate, shotStats } from './practice';
import type { Session, Shot, ShotOutcome } from './practice';
import { removeRecording } from './recordings';
import { Button, colors, Loading, message, Notice, Page, Panel, Placeholder, ScreenHeader, ui } from './ui';

type ShotEdit = { releaseMs: number; existing?: Shot };
const outcomes: { value: ShotOutcome; label: string }[] = [
  { value: 'made', label: 'Made' }, { value: 'missed', label: 'Missed' }, { value: 'unmarked', label: 'Unmarked' },
];

export function ReplayScreen({ initialSession, store, onBack, onViewDemo }: {
  initialSession: Session;
  store: PracticeStore;
  onBack: () => void;
  onViewDemo: () => void;
}) {
  const [session, setSession] = useState(initialSession);
  const [shots, setShots] = useState(() => store.listShots(session.id));
  const [edit, setEdit] = useState<ShotEdit>();
  const [editorError, setEditorError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const video = localVideoUri(session.videoPath);
  const stats = shotStats(shots);

  function editShot(selection: ShotEdit) {
    setEditorError(undefined);
    setEdit(selection);
  }

  function tag(outcome: ShotOutcome) {
    if (!edit) return;
    try {
      if (edit.existing) store.updateShot(session.id, edit.existing.shotNumber, outcome);
      else store.addShot(session.id, edit.releaseMs, outcome);
    } catch (error) {
      setEditorError(message(error, 'Your shot tag could not be saved.'));
      return;
    }
    setEdit(undefined);
    setShots(store.listShots(session.id));
  }

  function confirmRemove() {
    Alert.alert('Remove video?', 'The clip will be deleted from this iPhone. Its shot tags and stats will stay in Saved Clips.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove video', style: 'destructive', onPress: () => {
          try {
            removeRecording(session, recordingFiles, store);
            setSession({ ...session, videoPath: null });
            setNotice(undefined);
          } catch {
            setNotice('The video removal could not be completed. You can retry.');
          }
        },
      },
    ]);
  }

  return (
    <>
      <ScreenHeader title={video ? 'Replay' : 'Session stats'} onBack={onBack} />
      <Page>
        <View style={ui.group}>
          <Text style={ui.heading} accessibilityRole="header">{DRILL_NAME}</Text>
          <Text style={ui.body}>{sessionDate(session.createdAt)}</Text>
        </View>
        {video ? (
          <ReplayPlayer uri={video} durationMs={session.durationMs} onTag={(releaseMs) => editShot({ releaseMs })} />
        ) : <Placeholder><Text style={ui.text}>Video unavailable</Text></Placeholder>}
        <Panel>
          <Text style={ui.label}>PRACTICE TIP</Text>
          <Text style={ui.text}>{PRACTICE_TIP}</Text>
          <Button label="View 3D demo" kind="secondary" onPress={onViewDemo} />
        </Panel>
        <Panel>
          <Text style={ui.title} accessibilityRole="header">Shot stats</Text>
          <View style={styles.stats}>
            <Stat label="Made / attempts" value={`${stats.makes} / ${stats.attempts}`} />
            <Stat label="Shot %" value={stats.percentage === null ? '—' : `${stats.percentage}%`} />
            <Stat label="Unmarked" value={String(stats.unmarked)} />
          </View>
          {stats.attempts === 0 ? <Text style={ui.body}>No made or missed attempts tagged yet.</Text> : null}
          {shots.map((shot) => (
            <Pressable
              key={shot.shotNumber}
              accessibilityRole="button"
              accessibilityLabel={`Edit shot ${shot.shotNumber}, ${shot.outcome}, at ${clipTime(shot.releaseMs, true)}`}
              onPress={() => editShot({ releaseMs: shot.releaseMs, existing: shot })}
              style={({ pressed }) => [styles.shotRow, pressed && styles.dimmed]}
            >
              <View style={ui.group}>
                <Text style={ui.text}>Shot {shot.shotNumber}</Text>
                <Text style={ui.time}>{clipTime(shot.releaseMs, true)}</Text>
              </View>
              <Text style={ui.text}>{outcomes.find(({ value }) => value === shot.outcome)?.label} ›</Text>
            </Pressable>
          ))}
        </Panel>
        {notice ? <Notice>{notice}</Notice> : null}
        {session.videoPath ? <Button label="Remove video" kind="danger" onPress={confirmRemove} /> : null}
      </Page>
      <Modal visible={!!edit} transparent animationType="slide" onRequestClose={() => setEdit(undefined)}>
        <SafeAreaView style={styles.modal} edges={['bottom']}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={ui.title} accessibilityRole="header">{edit?.existing ? 'Edit shot' : 'Tag shot'}</Text>
            {edit ? <Text style={ui.body}>Release at {clipTime(edit.releaseMs, true)}</Text> : null}
            {editorError ? <Notice>{editorError}</Notice> : null}
            {outcomes.map(({ value, label }) => (
              <Button key={value} label={label} kind="secondary" selected={edit?.existing?.outcome === value} onPress={() => tag(value)} />
            ))}
            <Button label="Cancel" kind="secondary" onPress={() => setEdit(undefined)} />
          </View>
        </SafeAreaView>
      </Modal>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <View style={styles.stat}><Text style={styles.statNumber}>{value}</Text><Text style={ui.body}>{label}</Text></View>;
}

function ReplayPlayer({ uri, durationMs, onTag }: { uri: string; durationMs: number; onTag: (ms: number) => void }) {
  const [attempt, setAttempt] = useState(0);
  return <ClipPlayer key={attempt} uri={uri} durationMs={durationMs} onTag={onTag} onRetry={() => setAttempt(attempt + 1)} />;
}

function ClipPlayer({ uri, durationMs, onTag, onRetry }: {
  uri: string;
  durationMs: number;
  onTag: (ms: number) => void;
  onRetry: () => void;
}) {
  const player = useVideoPlayer(uri, (item) => {
    item.timeUpdateEventInterval = 0.1;
    item.seekTolerance = { toleranceBefore: 0, toleranceAfter: 0 };
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const time = useEvent(player, 'timeUpdate');
  const [scrub, setScrub] = useState<number>();
  const [seekTarget, setSeekTarget] = useState<number>();
  const [slow, setSlow] = useState(false);
  const duration = player.duration || durationMs / 1000;
  const elapsed = Math.min(duration, scrub ?? seekTarget ?? time?.currentTime ?? player.currentTime);
  const ready = status === 'readyToPlay';

  if (status === 'error') {
    return <Panel><Notice>The saved video could not be played.</Notice><Button label="Retry playback" kind="secondary" onPress={onRetry} /></Panel>;
  }

  return (
    <View style={ui.group}>
      <View style={styles.player}>
        <VideoView accessible={false} style={StyleSheet.absoluteFill} player={player} nativeControls={false} contentFit="contain" />
        {ready ? null : <Loading text="Opening clip…" />}
      </View>
      <Slider
        accessibilityLabel="Video playhead"
        disabled={!ready}
        minimumValue={0}
        maximumValue={duration}
        value={elapsed}
        minimumTrackTintColor={colors.accent}
        maximumTrackTintColor={colors.border}
        thumbTintColor={colors.accent}
        style={styles.scrubber}
        onSlidingStart={() => { player.pause(); setScrub(elapsed); }}
        onValueChange={setScrub}
        onSlidingComplete={(seconds) => {
          player.currentTime = seconds;
          setSeekTarget(seconds);
          setScrub(undefined);
        }}
      />
      <View style={ui.row}><Text style={ui.time}>{clipTime(elapsed * 1000, true)}</Text><Text style={ui.time}>{clipTime(durationMs, true)}</Text></View>
      <View style={styles.controls}>
        <Button label={isPlaying ? 'Pause' : 'Play'} kind="secondary" disabled={!ready} onPress={() => {
          if (player.playing) player.pause();
          else {
            const nextPosition = seekTarget ?? player.currentTime;
            setSeekTarget(undefined);
            if (nextPosition >= duration - 0.05) player.replay();
            else player.play();
            const rate = slow ? 0.5 : 1;
            if (player.playbackRate !== rate) player.playbackRate = rate;
          }
        }} />
        <Button label="0.5× speed" kind="secondary" disabled={!ready} selected={slow} onPress={() => {
          if (player.playing) player.playbackRate = slow ? 1 : 0.5;
          setSlow(!slow);
        }} />
        <Button label="Tag shot" disabled={!ready || scrub !== undefined} onPress={() => {
          player.pause();
          const release = seekTarget ?? player.currentTime;
          onTag(Math.min(durationMs, Math.round(Math.max(0, release) * 1000)));
        }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  player: { aspectRatio: 16 / 10, backgroundColor: '#050506', borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  scrubber: { height: 44, marginHorizontal: -4 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stat: { flex: 1, minWidth: 76, gap: 2 },
  statNumber: { color: colors.text, fontSize: 23, fontWeight: '700', fontVariant: ['tabular-nums'] },
  shotRow: { ...ui.row, minHeight: 54, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 10 },
  dimmed: { opacity: 0.55 },
  modal: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#0009' },
  sheet: { padding: 20, paddingBottom: 24, gap: 10, backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
});
