import { randomUUID } from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEvent } from 'expo';
import { useVideoPlayer } from 'expo-video';
import type { VideoThumbnail } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { PracticeStore } from './database';
import { inspectRecording, localVideoUri, recordingFiles, removeIfPresent } from './device-storage';
import { clipTime, DRILL_NAME, RECORD_LIMIT_SECONDS, RECORD_MAX_BYTES, sessionTime, STORAGE_RESERVE_BYTES, type Session } from './practice';
import { confirmRecordingFootage } from './recording-review';
import { saveConfirmedRecording } from './recordings';
import {
  Button, colors, fonts, gradients, Icon, Loading, message, Notice, Page, Panel, StatsGrid, Strip,
  TextButton, Title, TopBar, ui,
} from './ui';

export function SavedClips({ store, onMenu, onRecord, onReplay }: {
  store: PracticeStore;
  onMenu: () => void;
  onRecord: () => void;
  onReplay: (session: Session) => void;
}) {
  const [latest, ...earlier] = store.listSessionSummaries();
  const available = !!latest && !!localVideoUri(latest.videoPath);

  return (
    <>
      <TopBar onMenu={onMenu} />
      <Page style={styles.library}>
        {!latest ? (
          <>
            <Strip label="YOUR CLIPS" detail="ON THIS IPHONE" />
            <View style={styles.emptyTitle}><Title title="Saved clips" subtitle="Find your recordings here." /></View>
            <View style={styles.empty}>
              <Icon name="empty" />
              <Text style={styles.emptyHeading} accessibilityRole="header">NO SAVED CLIPS YET</Text>
              <Text style={styles.emptyCopy}>Record a practice clip to review it and tag your shots here.</Text>
            </View>
            <Button label="Record practice" icon="record" onPress={onRecord} style={styles.emptyAction} />
          </>
        ) : (
          <>
            {available ? null : <Strip label="YOUR CLIPS" detail="ON THIS IPHONE" />}
            <View style={available ? undefined : styles.emptyTitle}>
              <Title title="Saved clips" subtitle="Open a session to review your shot and stats." />
            </View>
            <Panel>
              <View style={ui.row}>
                <Text style={styles.lightMono}>LATEST SESSION</Text>
                <Text style={ui.label}>{available ? clipTime(latest.durationMs) : 'STATS ONLY'}</Text>
              </View>
              <View style={styles.latestTitle}>
                <Text style={ui.mono}>{sessionTime(latest.createdAt).toUpperCase()}</Text>
                <Text style={ui.title}>{DRILL_NAME}</Text>
              </View>
              <StatsGrid stats={latest.stats} showFg={!available} />
              <Button label={available ? 'View session' : 'View stats'} onPress={() => onReplay(latest)} arrow style={styles.latestAction} />
            </Panel>
            {earlier.length ? (
              <View style={styles.earlier}>
                <View style={ui.row}>
                  <Text style={styles.lightMono}>EARLIER SESSIONS</Text><Text style={ui.label}>FG%</Text>
                </View>
                {earlier.map((session, index) => {
                  const hasVideo = !!localVideoUri(session.videoPath);
                  const { percentage } = session.stats;
                  return (
                    <Pressable key={session.id} accessibilityRole="button"
                      accessibilityLabel={'View session from ' + sessionTime(session.createdAt)}
                      onPress={() => onReplay(session)}
                      style={({ pressed }) => [styles.sessionRow, index !== 0 && styles.separator, pressed && styles.dimmed]}>
                      <Icon name={hasVideo ? 'video' : 'videoOff'} />
                      <View style={styles.flex}>
                        <Text style={styles.sessionTitle}>{sessionTime(session.createdAt)}</Text>
                        <Text style={ui.body}>{hasVideo ? clipTime(session.durationMs) + ' clip' : 'Video removed'}</Text>
                      </View>
                      <Text style={ui.label}>{percentage === null ? '—' : percentage + '%'}</Text>
                      <Icon name="chevron" />
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </>
        )}
      </Page>
    </>
  );
}

export function ClipPicker({ store, userId, onSelect, onImported, onCancel }: {
  store: PracticeStore;
  userId: string | null;
  onSelect: (session: Session) => void;
  onImported: (session: Session) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<'opening' | 'checking' | 'saving'>();
  const busy = phase !== undefined;
  const [notice, setNotice] = useState<string>();
  const importing = useRef(false);
  const sessions = store.listSessions().flatMap((session) => {
    const uri = localVideoUri(session.videoPath);
    return uri ? [{ session, uri }] : [];
  });

  async function importClip() {
    if (importing.current) return;
    importing.current = true;
    setNotice(undefined);
    setPhase('opening');
    let source: string | undefined;
    let saving = false;
    try {
      if (Paths.availableDiskSpace < STORAGE_RESERVE_BYTES + RECORD_MAX_BYTES) {
        throw new Error('Free at least 32 MB on this iPhone before importing a clip.');
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        videoExportPreset: ImagePicker.VideoExportPreset.MediumQuality,
      });
      if (result.canceled) return;
      source = result.assets[0]?.uri;
      if (!source) throw new Error('No video was selected.');
      const extension = new File(source).extension.toLowerCase();
      if (!['.mov', '.mp4', '.m4v'].includes(extension)) throw new Error('Choose a MOV, MP4, or M4V video.');
      if (recordingFiles.size(source) > RECORD_MAX_BYTES) throw new Error('Choose a video smaller than 20 MB.');
      const draft = await inspectRecording(source, randomUUID(), Date.now());
      if (draft.durationMs > RECORD_LIMIT_SECONDS * 1000) throw new Error('Choose a video up to 30 seconds long.');
      setPhase('checking');
      const saved = await saveConfirmedRecording(draft, recordingFiles, store, async () => {
        if (!await confirmRecordingFootage(draft.sourceUri)) return false;
        saving = true;
        setPhase('saving');
        return true;
      }, userId);
      if (saved) onImported(saved);
    } catch (error) {
      setNotice(message(error, 'The video could not be imported.'));
    } finally {
      if (source?.startsWith(Paths.cache.uri) && !saving) {
        try { removeIfPresent(source); } catch { /* The picker’s cache can be purged by the system. */ }
      }
      setPhase(undefined);
      importing.current = false;
    }
  }

  return (
    <View style={styles.flex}>
      <View style={styles.pickerBar}>
        <TextButton label="Cancel" onPress={onCancel} disabled={busy} style={styles.cancel} />
        <Text accessibilityRole="header" style={styles.pickerTitle}>Recents</Text>
        <TextButton label="Photos" onPress={importClip} disabled={busy} style={styles.photos} />
      </View>
      <Text style={styles.pickerCopy}>Choose a video of your shot</Text>
      {notice || busy ? (
        <View style={styles.importAction}>
          {notice ? <Notice>{notice}</Notice> : null}
          {phase ? <Loading text={phase === 'checking' ? 'Checking for a shot…' : phase === 'saving' ? 'Saving to this iPhone…' : 'Opening video…'} /> : null}
        </View>
      ) : null}
      <FlatList
        data={sessions}
        numColumns={3}
        keyExtractor={({ session }) => session.id}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.grid}
        ListEmptyComponent={<Text style={styles.pickerCopy}>No practice videos on this iPhone yet.</Text>}
        renderItem={({ item }) => <ClipTile session={item.session} uri={item.uri} onSelect={onSelect} disabled={busy} />}
      />
    </View>
  );
}

function ClipTile({ session, uri, disabled, onSelect }: {
  session: Session; uri: string; disabled: boolean; onSelect: (session: Session) => void;
}) {
  const player = useVideoPlayer(uri);
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const [preview, setPreview] = useState<VideoThumbnail>();
  useEffect(() => {
    if (status !== 'readyToPlay') return;
    let valid = true;
    void player.generateThumbnailsAsync([Math.min(player.duration / 2, 0.6)], { maxWidth: 320, maxHeight: 320 })
      .then(([item]) => { if (valid) setPreview(item); }, () => {});
    return () => { valid = false; };
  }, [player, status]);

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={'Attach video from ' + sessionTime(session.createdAt)}
      disabled={disabled} onPress={() => onSelect(session)}
      style={({ pressed }) => [styles.tile, (disabled || pressed) && styles.dimmed]}>
      <LinearGradient colors={gradients.clip} style={StyleSheet.absoluteFill} />
      {preview ? <Image source={preview} style={StyleSheet.absoluteFill} contentFit="cover" accessible={false} /> : null}
      <LinearGradient colors={['transparent', '#100707b3']} style={styles.tileCaption}>
        <Icon name="play" /><Text style={styles.tileTime}>{clipTime(session.durationMs)}</Text>
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  library: { gap: 18 },
  emptyTitle: { marginTop: 14 },
  empty: { alignItems: 'center', gap: 12, marginTop: 41 },
  emptyHeading: { ...ui.heading, fontSize: 28, lineHeight: 35, textAlign: 'center' },
  emptyCopy: { ...ui.serif, textAlign: 'center', maxWidth: 250 },
  emptyAction: { marginTop: 14 },
  lightMono: { ...ui.mono, color: colors.text },
  latestTitle: { marginTop: 12, gap: 1 },
  latestAction: { minHeight: 47, marginTop: 4 },
  earlier: { paddingHorizontal: 12, marginTop: 10 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', minHeight: 64, gap: 11 },
  separator: { borderTopWidth: 1, borderTopColor: colors.border },
  sessionTitle: { ...ui.text, fontFamily: fonts.semibold },
  dimmed: { opacity: 0.6 },
  pickerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, minHeight: 49 },
  pickerTitle: { ...ui.title, fontSize: 16 },
  cancel: { minWidth: 78, alignItems: 'flex-start' },
  photos: { minWidth: 78, alignItems: 'flex-end' },
  pickerCopy: { ...ui.body, textAlign: 'center', paddingVertical: 10 },
  importAction: { paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
  grid: { paddingHorizontal: 16, paddingBottom: 16, gap: 4 },
  gridRow: { gap: 4 },
  tile: { flexBasis: '32%', flexGrow: 0, aspectRatio: 1, backgroundColor: colors.media, overflow: 'hidden', borderRadius: 4 },
  tileCaption: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 6, paddingTop: 16, ...ui.row },
  tileTime: { ...ui.mono, color: colors.text, fontSize: 10 },
});
