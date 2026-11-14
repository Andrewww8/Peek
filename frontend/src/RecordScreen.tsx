import { CameraView, useCameraPermissions } from 'expo-camera';
import { randomUUID } from 'expo-crypto';
import { isDevice } from 'expo-device';
import { Paths } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { PracticeStore } from './database';
import { inspectRecording, recordingFiles } from './device-storage';
import { clipTime, DRILL_NAME, RECORD_LIMIT_SECONDS, RECORD_MAX_BYTES } from './practice';
import type { Session } from './practice';
import { RECORDING_FREE_BYTES, saveRecording } from './recordings';
import type { RecordingDraft } from './recordings';
import { Button, colors, Loading, message, Notice, Page, Panel, Placeholder, ScreenHeader, ui } from './ui';

type Phase = 'idle' | 'recording' | 'stopping' | 'saving' | 'saveFailed';
type PendingClip = { uri: string; id: string; createdAt: number; draft?: RecordingDraft };

export function RecordScreen({ store, onBack, onSaved }: {
  store: PracticeStore;
  onBack: () => void;
  onSaved: (session: Session) => void;
}) {
  const [permission, requestPermission, refreshPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('idle');
  const [cameraKey, setCameraKey] = useState(0);
  const [ready, setReady] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [askingPermission, setAskingPermission] = useState(false);
  const camera = useRef<CameraView>(null);
  const currentPhase = useRef<Phase>('idle');
  const pending = useRef<PendingClip>(null);

  function transition(next: Phase) {
    currentPhase.current = next;
    setPhase(next);
  }

  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshPermission().catch(() => undefined);
      } else if (state === 'background' && currentPhase.current === 'recording') {
        transition('stopping');
        camera.current?.stopRecording();
      }
    });
    return () => listener.remove();
  }, [refreshPermission]);

  async function allowCamera() {
    setAskingPermission(true);
    setNotice(undefined);
    try {
      if (permission?.canAskAgain) await requestPermission();
      else await Linking.openSettings();
    } catch {
      setNotice('Open iPhone Settings and allow camera access for Perspective.');
    } finally {
      setAskingPermission(false);
    }
  }

  async function savePending() {
    const clip = pending.current;
    if (!clip || currentPhase.current === 'saving') return;
    transition('saving');
    setNotice(undefined);
    try {
      clip.draft ??= await inspectRecording(clip.uri, clip.id, clip.createdAt);
      const session = saveRecording(clip.draft, recordingFiles, store);
      pending.current = null;
      onSaved(session);
    } catch (error) {
      setNotice(message(error, 'The clip could not be saved.'));
      transition('saveFailed');
    }
  }

  async function start() {
    const activeCamera = camera.current;
    if (!ready || !activeCamera || currentPhase.current !== 'idle') return;

    setNotice(undefined);
    if (Paths.availableDiskSpace < RECORDING_FREE_BYTES) {
      setNotice('Free at least 32 MB on this iPhone before recording.');
      return;
    }

    setElapsed(0);
    const createdAt = Date.now();
    transition('recording');
    try {
      const result = await activeCamera.recordAsync({
        codec: 'avc1',
        maxDuration: RECORD_LIMIT_SECONDS,
        maxFileSize: RECORD_MAX_BYTES,
        progressUpdateInterval: 0.25,
      });
      if (!result?.uri) throw new Error('No clip was recorded.');
      pending.current = { uri: result.uri, id: randomUUID(), createdAt };
      await savePending();
    } catch {
      transition('idle');
      setNotice('Recording stopped before a clip could be saved. Try recording again.');
    }
  }

  function stop() {
    if (currentPhase.current !== 'recording') return;
    transition('stopping');
    camera.current?.stopRecording();
  }

  function goBack() {
    if (currentPhase.current === 'idle') onBack();
    if (currentPhase.current === 'saveFailed') {
      Alert.alert('Leave this recording?', 'You can try saving again before leaving.', [
        { text: 'Keep trying', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: onBack },
      ]);
    }
  }

  const canShowCamera = isDevice && permission?.granted && !cameraError;
  const busy = phase === 'recording' || phase === 'stopping' || phase === 'saving';

  return (
    <>
      <ScreenHeader backLabel="Practice" detail="720P" onBack={goBack} backDisabled={busy} />
      <Page>
        <View>
          <Text style={ui.heading} accessibilityRole="header">Record practice</Text>
          <Text style={ui.body}>{DRILL_NAME}</Text>
        </View>
        {canShowCamera ? (
          <View style={styles.preview}>
            <CameraView
              key={cameraKey}
              ref={camera}
              style={StyleSheet.absoluteFill}
              facing="back"
              mode="video"
              mute
              responsiveOrientationWhenOrientationLocked
              videoQuality="720p"
              videoBitrate={4_000_000}
              onCameraReady={() => setReady(true)}
              onMountError={() => {
                setReady(false);
                setCameraError(true);
              }}
              onRecordingProgress={({ duration }) => setElapsed(duration)}
            />
            <View pointerEvents="none" style={styles.overlay}>
              <View style={styles.previewTop}>
                <Text style={styles.cameraTag}>SHOOTING SIDE</Text>
                <Text style={styles.timer}>{clipTime(elapsed * 1000)} / 0:30</Text>
              </View>
            </View>
          </View>
        ) : (
          <Placeholder>
            {!isDevice ? <Text style={ui.text}>Recording requires a physical iPhone.</Text> : null}
            {isDevice && !permission ? <Loading text="Checking camera access…" /> : null}
            {isDevice && permission && !permission.granted ? <Text style={ui.text}>Camera access is required to record.</Text> : null}
            {isDevice && permission?.granted && cameraError ? <Text style={ui.text}>The camera could not start.</Text> : null}
          </Placeholder>
        )}
        <Panel>
          <Text style={ui.title}>Keep the phone still</Text>
          <Text style={ui.body}>Set up on your shooting side. Keep your full body and the ball in frame through release.</Text>
        </Panel>
        {notice ? <Notice>{notice}</Notice> : null}
        {phase === 'idle' && isDevice && permission && !permission.granted ? (
          <Button label={permission.canAskAgain ? 'Allow camera access' : 'Open Settings'} onPress={allowCamera} disabled={askingPermission} />
        ) : null}
        {phase === 'idle' && isDevice && permission?.granted && cameraError ? (
          <Button label="Retry camera" onPress={() => {
            setNotice(undefined);
            setCameraKey((key) => key + 1);
            setCameraError(false);
          }} />
        ) : null}
        {phase === 'idle' && canShowCamera ? (
          <Shutter label={ready ? 'Start recording' : 'Starting camera…'} onPress={start} disabled={!ready} />
        ) : null}
        {phase === 'recording' ? <Shutter label="Stop and save" onPress={stop} recording disabled={elapsed === 0} /> : null}
        {phase === 'stopping' ? <Loading text="Finishing recording…" /> : null}
        {phase === 'saving' ? <Loading text="Saving to this iPhone…" /> : null}
        {phase === 'saveFailed' ? <Button label="Retry save" onPress={savePending} /> : null}
        {phase === 'idle' ? <Text style={styles.footnote}>30-second limit · Saves to this iPhone · Silent video</Text> : null}
      </Page>
    </>
  );
}

function Shutter({ label, onPress, disabled, recording = false }: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  recording?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.shutterButton, (disabled || pressed) && styles.disabled]}
    >
      <View style={styles.shutterRing}><View style={[styles.shutterFill, recording && styles.stopFill]} /></View>
      <Text style={ui.title}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  preview: { aspectRatio: 1.08, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.media },
  overlay: { ...StyleSheet.absoluteFill, padding: 12 },
  previewTop: { ...ui.row, alignItems: 'flex-start' },
  cameraTag: { ...ui.mono, color: colors.text, backgroundColor: colors.surface, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 5 },
  timer: { ...ui.time, color: colors.text, backgroundColor: colors.media, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 5 },
  shutterButton: { alignItems: 'center', gap: 8, minHeight: 44, paddingVertical: 7 },
  shutterRing: { width: 64, height: 64, borderRadius: 32, borderColor: colors.text, borderWidth: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  shutterFill: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#BA4435' },
  stopFill: { width: 27, height: 27, borderRadius: 5 },
  disabled: { opacity: 0.55 },
  footnote: { ...ui.body, fontSize: 13, textAlign: 'center' },
});
