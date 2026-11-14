import { BarlowCondensed_800ExtraBold } from '@expo-google-fonts/barlow-condensed/800ExtraBold';
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium';
import { InstrumentSans_400Regular } from '@expo-google-fonts/instrument-sans/400Regular';
import { InstrumentSans_600SemiBold } from '@expo-google-fonts/instrument-sans/600SemiBold';
import type { Session as AuthSession } from '@supabase/supabase-js';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { AccountScreen } from './AccountScreen';
import { storedSession, supabase } from './auth';
import type { PracticeStore } from './database';
import { DemoScreen } from './DemoScreen';
import { loadPractice, localVideoUri } from './device-storage';
import { clipTime, DRILL_NAME, sessionDate } from './practice';
import type { Session } from './practice';
import { RecordScreen } from './RecordScreen';
import { ReplayScreen } from './ReplayScreen';
import { Button, colors, fonts, Loading, Notice, Page, Panel, StatsGrid, Strip, ui } from './ui';
import { useClipSync } from './use-clip-sync';

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
  const [fontsReady, fontError] = useFonts({
    [fonts.display]: BarlowCondensed_800ExtraBold,
    [fonts.regular]: InstrumentSans_400Regular,
    [fonts.semibold]: InstrumentSans_600SemiBold,
    [fonts.mono]: IBMPlexMono_500Medium,
  });
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
        {!database || (!fontsReady && !fontError) ? <View style={styles.middle}><Loading text="Opening Perspective…" /></View> :
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
  const [account, setAccount] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const cloudUserId = session?.user.id ?? null;
  const scheduleClipSync = useClipSync(store, cloudUserId);

  useEffect(() => {
    if (!supabase) return;
    const auth = supabase.auth;
    const { data: { subscription } } = auth.onAuthStateChange((event, current) => {
      setSession(event === 'INITIAL_SESSION' && !current ? storedSession() : current);
      setAuthReady(true);
    });
    const appState = AppState.addEventListener('change', (state) => {
      const pending = state === 'active' ? auth.startAutoRefresh() : auth.stopAutoRefresh();
      void pending.catch(() => undefined);
    });
    return () => {
      subscription.unsubscribe();
      appState.remove();
      void auth.stopAutoRefresh().catch(() => undefined);
    };
  }, []);

  const tabName = tab === 'practice' ? 'Practice' : 'Saved clips';
  if (account) {
    return <AccountScreen session={session} ready={authReady} backLabel={demo ? '3D example' : tabName} onBack={() => setAccount(false)} />;
  }
  if (demo) {
    return <DemoScreen backLabel={detail?.screen === 'replay' ? 'Replay' : tabName} store={store}
      onBack={() => setDemo(false)} />;
  }
  if (detail?.screen === 'record') {
    return <RecordScreen store={store} cloudUserId={cloudUserId} onBack={() => setDetail(undefined)} onSaved={(session) => setDetail({ screen: 'replay', session })} />;
  }
  if (detail?.screen === 'replay') {
    return (
      <ReplayScreen
        key={detail.session.id}
        backLabel={tabName}
        initialSession={store.getSession(detail.session.id) ?? detail.session}
        store={store}
        cloudUserId={cloudUserId}
        onShotsChanged={scheduleClipSync}
        onBack={() => setDetail(undefined)}
        onViewDemo={() => setDemo(true)}
      />
    );
  }

  return (
    <>
      <View style={styles.brandBar}>
        <Text style={styles.brand}>Perspective</Text>
        <Button label={session ? 'Account' : 'Sign in'} kind="secondary" onPress={() => setAccount(true)} />
      </View>
      {tab === 'practice' ? (
        <Page>
          <Strip label="TRAINING" detail="BASKETBALL / 3PT" />
          <Panel>
            <Text style={ui.label}>SHOOTING DRILL</Text>
            <Text style={ui.drill} accessibilityRole="header">{DRILL_NAME}</Text>
            <Text style={ui.body}>Catch, set, and shoot from behind the arc.</Text>
            <View style={styles.drillDetails}>
              <Text style={ui.mono}>30-SECOND CLIP</Text>
              <Text style={ui.mono}>720P</Text>
            </View>
          </Panel>
          <Button label="Record practice" arrow onPress={() => setDetail({ screen: 'record' })} />
          <Panel>
            <Text style={ui.title}>Film from the shooting side</Text>
            <Text style={ui.body}>Keep the phone still and the player and ball in frame through release.</Text>
          </Panel>
          <Button label="View 3D example" arrow kind="secondary" onPress={() => setDemo(true)} />
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
  const [latest, ...earlier] = sessions;

  return (
    <Page>
      <Strip label="PRACTICE LOG" detail="ON THIS IPHONE" />
      <Text style={ui.heading} accessibilityRole="header">Saved Clips</Text>
      {!latest ? (
        <Panel>
          <Text style={ui.title}>No saved clips yet</Text>
          <Text style={ui.body}>Your practice videos and shot tags are stored on this iPhone.</Text>
          <Button label="Go to Practice" onPress={onRecord} />
        </Panel>
      ) : (
        <>
          <Panel>
            <Text style={ui.label}>LATEST SESSION</Text>
            <View style={styles.summaryTitle}>
              <Text style={ui.body}>{sessionDate(latest.createdAt)}</Text>
              <Text style={ui.title}>{DRILL_NAME}</Text>
            </View>
            <StatsGrid stats={latest.stats} />
            <Button label={localVideoUri(latest.videoPath) ? 'Open replay' : 'View session stats'} arrow onPress={() => onReplay(latest)} />
          </Panel>
          {earlier.length > 0 ? (
            <View style={styles.sessionList}>
              <Strip label="EARLIER SESSIONS" />
              {earlier.map((session) => {
                const videoAvailable = !!localVideoUri(session.videoPath);
                const { makes, attempts, percentage } = session.stats;
                return (
                  <Pressable key={session.id} accessibilityRole="button" onPress={() => onReplay(session)} style={({ pressed }) => [styles.sessionItem, pressed && styles.pressed]}>
                    <Text style={ui.text}>{sessionDate(session.createdAt)}</Text>
                    <View style={ui.row}>
                      <Text style={ui.mono}>{attempts ? `${makes} / ${attempts} made` : 'No tagged attempts'}</Text>
                      <Text style={ui.mono}>{percentage === null ? '—' : `${percentage}%`}</Text>
                      <Text style={ui.mono}>{videoAvailable ? clipTime(session.durationMs) : 'Video unavailable'}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </>
      )}
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
  brandBar: { ...ui.row, minHeight: 52, paddingHorizontal: 24 },
  brand: { color: colors.text, fontFamily: fonts.display, fontSize: 30, textTransform: 'uppercase' },
  drillDetails: { ...ui.row, borderTopColor: colors.border, borderTopWidth: 1, paddingTop: 14, marginTop: 4 },
  tabs: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 11, marginHorizontal: 24, marginBottom: 8, padding: 4, gap: 4, flexDirection: 'row' },
  tab: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 8, paddingHorizontal: 6 },
  activeTab: { backgroundColor: colors.selected },
  tabText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.muted, textAlign: 'center' },
  activeTabText: { color: colors.text },
  pressed: { opacity: 0.6 },
  summaryTitle: { gap: 4, paddingBottom: 3 },
  sessionList: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, backgroundColor: colors.surface, overflow: 'hidden' },
  sessionItem: { minHeight: 56, padding: 12, gap: 6, borderTopColor: colors.border, borderTopWidth: 1 },
});
