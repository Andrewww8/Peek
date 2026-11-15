import { CameraView, useCameraPermissions } from 'expo-camera';
import { randomUUID } from 'expo-crypto';
import { isDevice } from 'expo-device';
import { Paths } from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { PracticeStore } from './database';
import { inspectRecording, recordingFiles, removeIfPresent } from './device-storage';
import { RecordingDot } from './PeekMotion';
import { clipTime, RECORD_LIMIT_SECONDS, RECORD_MAX_BYTES } from './practice';
import type { Session } from './practice';
import { confirmRecordingFootage } from './recording-review';
import { finishRecordingReview, RECORDING_FREE_BYTES } from './recordings';
import type { FootageDecision, RecordingDraft } from './recordings';
import { RecordingSaveProgress } from './ShotAnalysisProgress';
import { Button, colors, gradients, IconButton, Loading, message, Notice, ui } from './ui';

type Phase = 'idle' | 'starting' | 'recording' | 'stopping' | 'checking' | 'saving' | 'saveFailed';
type PendingClip = { uri: string; id: string; createdAt: number; cloudUserId: string | null; draft?: RecordingDraft; decision?: FootageDecision };

export function RecordScreen({ store, cloudUserId, onBack, onSaved }: {
  store: PracticeStore;
  cloudUserId: string | null;
  onBack: () => void;
  onSaved: (session: Session) => void;
}) {
  const [permission, requestPermission, refreshPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('idle');
  const [cameraKey, setCameraKey] = useState(0);
  const [cameraError, setCameraError] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [askingPermission, setAskingPermission] = useState(false);
  const camera = useRef<CameraView>(null);
  const ready = useRef(false);
  const currentPhase = useRef<Phase>('idle');
  const pending = useRef<PendingClip>(null);
  const captureStarted = useRef(false);
  const stopOnStart = useRef(false);

  function transition(next: Phase) {
    currentPhase.current = next;
    setPhase(next);
  }

  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshPermission().catch(() => undefined);
      } else if (state === 'background') {
        if (currentPhase.current === 'recording') {
          transition('stopping');
          camera.current?.stopRecording();
        } else if (currentPhase.current === 'starting') {
          if (captureStarted.current) stopOnStart.current = true;
          else transition('idle');
        }
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
      setNotice('Open iPhone Settings and allow camera access for Peek.');
    } finally {
      setAskingPermission(false);
    }
  }

  async function savePending() {
    const clip = pending.current;
    if (!clip || currentPhase.current === 'checking' || currentPhase.current === 'saving') return;
    transition(clip.decision === 'save' ? 'saving' : 'checking');
    setNotice(undefined);
    try {
      clip.draft ??= await inspectRecording(clip.uri, clip.id, clip.createdAt);
      clip.decision ??= await confirmRecordingFootage(clip.uri);
      if (clip.decision === 'save') transition('saving');
      const session = finishRecordingReview(clip.draft, recordingFiles, store, clip.decision, clip.cloudUserId);
      pending.current = null;
      if (!session) {
        if (clip.uri.startsWith(Paths.cache.uri)) {
          try { removeIfPresent(clip.uri); } catch { /* iOS can clear the recording cache. */ }
        }
        setNotice('Recording discarded.');
        transition('idle');
        return;
      }
      onSaved(session);
    } catch (error) {
      setNotice(message(error, clip.decision === 'discard' ? 'The discard could not be completed.' : 'The clip could not be saved.'));
      transition('saveFailed');
    }
  }

  function requestRecording() {
    if (currentPhase.current !== 'idle') return;
    setNotice(undefined);
    if (Paths.availableDiskSpace < RECORDING_FREE_BYTES) {
      setNotice('Free at least 32 MB on this iPhone before recording.');
      return;
    }
    setElapsed(0);
    transition('starting');
    if (ready.current) void start();
  }

  async function start() {
    const activeCamera = camera.current;
    if (!activeCamera || currentPhase.current !== 'starting' || captureStarted.current) return;
    captureStarted.current = true;
    const createdAt = Date.now();
    try {
      const result = await activeCamera.recordAsync({
        codec: 'avc1',
        maxDuration: RECORD_LIMIT_SECONDS,
        maxFileSize: RECORD_MAX_BYTES,
        progressUpdateInterval: 0.1,
      });
      if (!result?.uri) throw new Error('No clip was recorded.');
      pending.current = { uri: result.uri, id: randomUUID(), createdAt, cloudUserId };
      await savePending();
    } catch {
      transition('idle');
      setNotice('Recording stopped before a clip could be saved. Try recording again.');
    } finally {
      captureStarted.current = false;
      stopOnStart.current = false;
    }
  }

  function onProgress(duration: number) {
    if (currentPhase.current === 'starting' && duration > 0) {
      if (stopOnStart.current) {
        transition('stopping');
        camera.current?.stopRecording();
      } else {
        transition('recording');
      }
    }
    if (currentPhase.current === 'recording') {
      const wholeSeconds = Math.floor(duration);
      setElapsed((previous) => previous === wholeSeconds ? previous : wholeSeconds);
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
  const busy = phase === 'starting' || phase === 'recording' || phase === 'stopping' || phase === 'checking' || phase === 'saving';
  const recording = phase === 'recording' || phase === 'stopping';

  return (
    <View style={styles.screen}>
      <LinearGradient colors={gradients.camera} locations={[0, 0.72, 1]} style={styles.preview}>
        {canShowCamera ? (
          <>
            <CameraView
              key={cameraKey}
              ref={camera}
              style={StyleSheet.absoluteFill}
              facing="back"
              mode="video"
              mute
              videoQuality="720p"
              videoBitrate={4_000_000}
              videoStabilizationMode="off"
              onCameraReady={() => {
                ready.current = true;
                if (currentPhase.current === 'starting') void start();
              }}
              onMountError={() => {
                ready.current = false;
                setCameraError(true);
                if (currentPhase.current === 'starting' && !captureStarted.current) transition('idle');
              }}
              onRecordingProgress={({ duration }) => onProgress(duration)}
            />
            <View pointerEvents="none" style={styles.guide}>
              <View style={styles.frame} />
              <Text style={styles.guideText}>Keep the player and ball in frame</Text>
            </View>
          </>
        ) : (
          <View style={styles.cameraMessage}>
            {!isDevice ? <Text style={ui.text}>Recording requires a physical iPhone.</Text> : null}
            {isDevice && !permission ? <Loading text="Checking camera access…" /> : null}
            {isDevice && permission && !permission.granted ? <Text style={ui.text}>Camera access is required to record.</Text> : null}
            {isDevice && permission?.granted && cameraError ? <Text style={ui.text}>The camera could not start.</Text> : null}
          </View>
        )}
        <View style={styles.previewTop}>
          <IconButton icon="close" label="Close camera" onPress={goBack} disabled={busy} style={styles.cameraClose} />
          <View style={styles.timerPosition} pointerEvents="none">
            <View style={[styles.pill, recording && styles.activePill]}>
              {recording ? <RecordingDot /> : null}
              <Text style={ui.time}>{clipTime(elapsed * 1000)}</Text>
            </View>
          </View>
          <View style={styles.pill}><Text style={[ui.mono, styles.quality]}>720P · 30S</Text></View>
        </View>
      </LinearGradient>
      <View style={styles.actions}>
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
          <Shutter label="Start recording" onPress={requestRecording} />
        ) : null}
        {phase === 'starting' ? <Shutter label="Starting recording" onPress={requestRecording} disabled recording /> : null}
        {phase === 'recording' ? <Shutter label="Stop and save" onPress={stop} recording /> : null}
        {phase === 'stopping' ? <Loading text="Finishing recording…" /> : null}
        {phase === 'checking' ? <RecordingSaveProgress label="Checking for a shot…" /> : null}
        {phase === 'saving' ? <RecordingSaveProgress /> : null}
        {phase === 'saveFailed' ? <Button label={pending.current?.decision === 'discard' ? 'Retry discard' : 'Retry save'} onPress={savePending} /> : null}
      </View>
    </View>
  );
}

function Shutter({ label, onPress, disabled, recording = false }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 8 },
  preview: { flex: 1, minHeight: 160, borderRadius: 28, overflow: 'hidden' },
  previewTop: { ...ui.row, padding: 16 },
  cameraClose: { backgroundColor: '#0d0d0ddd', minWidth: 40, minHeight: 40, borderRadius: 20 },
  timerPosition: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  pill: { backgroundColor: '#0d0d0ddd', borderRadius: 20, paddingHorizontal: 10, minHeight: 27, flexDirection: 'row', alignItems: 'center', gap: 5 },
  activePill: { backgroundColor: colors.selected },
  quality: { color: colors.text },
  guide: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 12, paddingTop: 40 },
  frame: { width: '67%', height: '67%', borderWidth: 1.5, borderColor: '#f7f3ed77', borderRadius: 18, borderStyle: 'dashed' },
  guideText: { ...ui.body, fontSize: 12, color: colors.text, textShadowColor: '#000', textShadowRadius: 5 },
  cameraMessage: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', padding: 32 },
  actions: { justifyContent: 'center', minHeight: 116, paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  shutterButton: { alignSelf: 'center', borderRadius: 40 },
  shutterRing: { width: 80, height: 80, borderRadius: 40, borderColor: colors.text, borderWidth: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  shutterFill: { width: 62, height: 62, borderRadius: 31, backgroundColor: colors.accent },
  stopFill: { width: 30, height: 30, borderRadius: 7 },
  disabled: { opacity: 0.55 },
});
