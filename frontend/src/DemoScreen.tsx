import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { apiUrl } from './api';
import type { PracticeStore, SavedDemo } from './database';
import { cachedDemo, downloadDemo, fetchDemoCatalog } from './demos';
import type { CatalogDemo } from './demos';
import { demoFiles, openModel } from './device-storage';
import { DRILL_NAME } from './practice';
import { Button, colors, Loading, message, Notice, Page, Panel, Placeholder, ScreenHeader, ui } from './ui';

type DownloadState = 'idle' | 'checking' | 'downloading' | 'opening';

export function DemoScreen({ store, backLabel, onBack, onCompare }: {
  store: PracticeStore;
  backLabel: string;
  onBack: () => void;
  onCompare: () => void;
}) {
  const [saved, setSaved] = useState<SavedDemo | null>(() => cachedDemo(store, demoFiles));
  const [available, setAvailable] = useState<CatalogDemo>();
  const [state, setState] = useState<DownloadState>('idle');
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const active = useRef<AbortController | null>(null);
  const opening = useRef(false);

  useEffect(() => () => {
    const operation = active.current;
    active.current = null;
    operation?.abort();
  }, []);

  async function checkCatalogOrDownload(replace = false) {
    if (active.current || opening.current) return;

    const operation = new AbortController();
    active.current = operation;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setNotice(undefined);
    setInfo(undefined);
    setProgress(0);
    setState('checking');

    try {
      timeout = setTimeout(() => operation.abort(), 12_000);
      const catalog = await fetchDemoCatalog(apiUrl, operation.signal);
      clearTimeout(timeout);
      if (operation.signal.aborted) throw new Error('The demo request timed out. Try again.');
      const offers = saved ? catalog.filter(({ id }) => id === saved.id) : catalog;
      const latest = offers[0];
      if (!latest && (!saved || replace)) throw new Error('The server has no downloadable 3D example for this drill.');
      if (saved && !replace && (!latest || latest.version <= saved.version)) {
        setAvailable(undefined);
        setInfo('Your saved demo is ready to open.');
        return;
      }
      if (!latest) return;
      if (saved && replace && latest.version < saved.version) {
        throw new Error('The server does not have this version. The downloaded model is still on this iPhone.');
      }

      if (saved && !replace && available?.version !== latest.version) {
        setAvailable(latest);
        return;
      }

      timeout = setTimeout(() => operation.abort(), 120_000);
      setState('downloading');
      const downloaded = await downloadDemo(latest, store, demoFiles, (next) => {
        if (active.current === operation) setProgress(next);
      }, operation.signal);
      if (active.current === operation) {
        setSaved(downloaded);
        setAvailable(undefined);
        setPreviewFailed(false);
      }
    } catch (error) {
      if (active.current === operation) {
        setNotice(message(error, 'The demo could not be downloaded. Try again.'));
      }
    } finally {
      clearTimeout(timeout);
      if (active.current === operation) {
        active.current = null;
        setState('idle');
      }
    }
  }

  async function openSaved() {
    if (!saved || opening.current || active.current) return;

    const usable = cachedDemo(store, demoFiles);
    setSaved(usable);
    if (!usable) {
      setNotice('The saved model is missing. Download it again to open it.');
      return;
    }
    opening.current = true;
    setState('opening');
    setNotice(undefined);
    setPreviewFailed(false);
    try {
      await openModel(usable.localPath);
    } catch {
      setNotice('Quick Look could not open this model. You can try again or redownload it.');
      setPreviewFailed(true);
    } finally {
      opening.current = false;
      setState('idle');
    }
  }

  return (
    <>
      <ScreenHeader backLabel={backLabel} detail={saved ? 'OFFLINE READY' : undefined} onBack={onBack} backDisabled={state === 'opening'} />
      <Page>
        <View>
          <Text style={ui.heading} accessibilityRole="header">3D example</Text>
          <Text style={ui.body}>{DRILL_NAME}</Text>
        </View>
        <Button label="Compare two NBA examples" arrow onPress={onCompare} />
        <Placeholder>
          {state === 'downloading' ? (
            <View style={styles.progressOuter}>
              <Text style={ui.text}>Downloading · {Math.round(progress * 100)}%</Text>
              <View
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel="Model download"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
                style={styles.track}
              >
                <View style={[styles.fill, { width: `${progress * 100}%` }]} />
              </View>
            </View>
          ) : state === 'checking' || state === 'opening' ? (
            <Loading text={state === 'checking' ? 'Checking for the model…' : 'Opening Quick Look…'} />
          ) : (
            <View style={styles.mediaContent}>
              <Text style={[ui.mono, styles.mediaLabel]}>ANIMATED MODEL</Text>
              <Text style={ui.mono}>{saved ? 'Downloaded to this iPhone' : 'Model download required'}</Text>
            </View>
          )}
        </Placeholder>
        {saved ? <Panel emphasis><Text style={ui.label}>COACHING CUE</Text><Text style={ui.text}>{saved.cue}</Text></Panel> : null}
        {notice ? <Notice>{notice}</Notice> : null}
        {info ? <Text style={ui.body}>{info}</Text> : null}
        {saved ? <Button label="Open in Quick Look" arrow onPress={openSaved} disabled={state !== 'idle'} /> : null}
        <Button
          label={available ? 'Download update' : saved ? 'Check for update' : notice ? 'Retry download' : 'Download 3D model'}
          kind={saved ? 'secondary' : 'primary'}
          onPress={() => checkCatalogOrDownload()}
          disabled={state !== 'idle'}
        />
        {previewFailed && saved && state === 'idle' ? (
          <Button label="Redownload model" kind="secondary" onPress={() => checkCatalogOrDownload(true)} />
        ) : null}
      </Page>
    </>
  );
}

const styles = StyleSheet.create({
  mediaContent: { width: '100%', minHeight: 236, justifyContent: 'center', alignItems: 'center', paddingTop: 24 },
  mediaLabel: { position: 'absolute', top: 0, left: 0, backgroundColor: colors.surface, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 4 },
  progressOuter: { width: '100%', gap: 12 },
  track: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.accent },
});
