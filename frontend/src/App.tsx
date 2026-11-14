import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import type { PracticeStore } from './database';
import { DemoScreen } from './DemoScreen';
import { loadPractice, localVideoUri } from './device-storage';
import { clipTime, DRILL_NAME, sessionDate } from './practice';
import type { Session } from './practice';
import { RecordScreen } from './RecordScreen';
import { ReplayScreen } from './ReplayScreen';
import { Button, colors, Loading, Notice, Page, Panel, ui } from './ui';

type Tab = 'practice' | 'saved';
type Detail = { screen: 'record' } | { screen: 'replay'; session: Session };
type StoreState = { store: PracticeStore } | { error: true } | null;

let startup: Promise<PracticeStore> | undefined;
function getPracticeStore() {
  startup ??= loadPractice().catch((error) => {
    startup = undefined;
    throw error;
  });
  return startup;
}

export default function App() {
  const [database, setDatabase] = useState<StoreState>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);

  useEffect(() => {
    let subscribed = true;
    void getPracticeStore().then((store) => {
      if (subscribed) setDatabase({ store });
    }, () => {
      if (subscribed) setDatabase({ error: true });
    });
    return () => { subscribed = false; };
  }, [startupAttempt]);

  return (
    <SafeAreaProvider style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root}>
        {!database ? <View style={styles.middle}><Loading text="Opening Perspective…" /></View> :
          'error' in database ? (
            <View style={styles.middle}>
              <Notice>Practice history could not be opened.</Notice>
              <Button label="Retry" onPress={() => {
                setDatabase(null);
                setStartupAttempt((attempt) => attempt + 1);
              }} />
            </View>
          ) : <PracticeApp store={database.store} />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function PracticeApp({ store }: { store: PracticeStore }) {
  const [tab, setTab] = useState<Tab>('practice');
  const [detail, setDetail] = useState<Detail>();
  const [demo, setDemo] = useState(false);

  if (demo) return <DemoScreen store={store} onBack={() => setDemo(false)} />;
  if (detail?.screen === 'record') {
    return <RecordScreen store={store} onBack={() => setDetail(undefined)} onSaved={(session) => setDetail({ screen: 'replay', session })} />;
  }
  if (detail?.screen === 'replay') {
    return (
      <ReplayScreen
        key={detail.session.id}
        initialSession={store.getSession(detail.session.id) ?? detail.session}
        store={store}
        onBack={() => setDetail(undefined)}
        onViewDemo={() => setDemo(true)}
      />
    );
  }

  return (
    <>
      <View style={styles.brandBar}><Text style={styles.brand}>Perspective</Text></View>
      {tab === 'practice' ? (
        <Page>
          <Text style={ui.heading} accessibilityRole="header">Practice</Text>
          <Panel>
            <Text style={ui.label}>BASKETBALL</Text>
            <Text style={ui.title} accessibilityRole="header">{DRILL_NAME}</Text>
            <Text style={ui.body}>Record up to 30 seconds. Review your release and tag each shot in replay.</Text>
            <Button label="Record practice" onPress={() => setDetail({ screen: 'record' })} />
            <Button label="View 3D demo" kind="secondary" onPress={() => setDemo(true)} />
          </Panel>
        </Page>
      ) : <SavedClips store={store} onRecord={() => setTab('practice')} onReplay={(session) => setDetail({ screen: 'replay', session })} />}
      <View style={styles.tabs} accessibilityRole="tablist">
        <TabButton label="Practice" selected={tab === 'practice'} onPress={() => setTab('practice')} />
        <TabButton label="Saved Clips" selected={tab === 'saved'} onPress={() => setTab('saved')} />
      </View>
    </>
  );
}

function SavedClips({ store, onRecord, onReplay }: {
  store: PracticeStore;
  onRecord: () => void;
  onReplay: (session: Session) => void;
}) {
  const sessions = store.listSessionSummaries();

  return (
    <Page>
      <Text style={ui.heading} accessibilityRole="header">Saved Clips</Text>
      {sessions.length === 0 ? (
        <Panel>
          <Text style={ui.title}>No saved clips yet</Text>
          <Text style={ui.body}>Your practice videos and shot tags are stored on this iPhone.</Text>
          <Button label="Go to Practice" onPress={onRecord} />
        </Panel>
      ) : sessions.map((session) => {
        const videoAvailable = !!localVideoUri(session.videoPath);
        const { makes, attempts } = session.stats;
        return (
          <Pressable key={session.id} accessibilityRole="button" onPress={() => onReplay(session)} style={({ pressed }) => pressed && styles.pressed}>
            <Panel>
              <Text style={ui.title}>{DRILL_NAME}</Text>
              <Text style={ui.body}>{sessionDate(session.createdAt)}</Text>
              <View style={[ui.row, styles.sessionMeta]}>
                <Text style={ui.time}>{videoAvailable ? clipTime(session.durationMs) : 'Video unavailable'}</Text>
                <Text style={ui.time}>{attempts ? `${makes} / ${attempts} made` : 'No tagged attempts'}</Text>
              </View>
            </Panel>
          </Pressable>
        );
      })}
    </Page>
  );
}

function TabButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.tab, selected && styles.activeTab, pressed && styles.pressed]}
    >
      <Text style={[styles.tabText, selected && styles.activeTabText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  middle: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  brandBar: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, minHeight: 48, justifyContent: 'center', paddingHorizontal: 20 },
  brand: { color: colors.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  tabs: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 16, gap: 12, flexDirection: 'row' },
  tab: { flex: 1, minHeight: 54, justifyContent: 'center', alignItems: 'center', borderTopWidth: 2, borderTopColor: 'transparent' },
  activeTab: { borderTopColor: colors.accent },
  tabText: { fontSize: 15, fontWeight: '700', color: colors.muted, textAlign: 'center' },
  activeTabText: { color: colors.accent },
  pressed: { opacity: 0.6 },
  sessionMeta: { flexWrap: 'wrap' },
});
