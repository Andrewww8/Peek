import { BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed/700Bold';
import { IBMPlexMono_400Regular } from '@expo-google-fonts/ibm-plex-mono/400Regular';
import { IBMPlexMono_700Bold } from '@expo-google-fonts/ibm-plex-mono/700Bold';
import { Lora_400Regular } from '@expo-google-fonts/lora/400Regular';
import { Lora_700Bold } from '@expo-google-fonts/lora/700Bold';
import { Lora_700Bold_Italic } from '@expo-google-fonts/lora/700Bold_Italic';
import { Poppins_400Regular } from '@expo-google-fonts/poppins/400Regular';
import { Poppins_600SemiBold } from '@expo-google-fonts/poppins/600SemiBold';
import { Poppins_800ExtraBold } from '@expo-google-fonts/poppins/800ExtraBold';
import type { Session as AuthSession } from '@supabase/supabase-js';
import { useFonts } from 'expo-font';
import { SQLiteStorage } from 'expo-sqlite/kv-store';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View,
} from 'react-native';
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { AccountScreen, AuthScreen, SwitchAccount } from './AccountScreen';
import type { EntryMode } from './AccountScreen';
import { accountName, loadRecentChats, passwordRecoveryCode, rememberAccount, saveRecentChats, startGuestSession, storedSession, supabase } from './auth';
import type { RecentChat } from './coach';
import { CoachScreen } from './CoachScreen';
import { ComparisonScreen } from './ComparisonScreen';
import type { PracticeStore } from './database';
import { DemoScreen } from './DemoScreen';
import { loadPractice } from './device-storage';
import { ClipPicker, SavedClips } from './LibraryScreen';
import { Splash } from './PeekMotion';
import type { Session } from './practice';
import { RecordScreen } from './RecordScreen';
import { ReplayScreen } from './ReplayScreen';
import {
  Brand, Button, colors, Divider, fonts, Icon, IconButton, Notice, Page, TextButton, ui,
} from './ui';
import { useClipSync } from './use-clip-sync';

type Route =
  | { screen: 'welcome' | 'coach' | 'saved' | 'account' | 'switch' | 'picker' }
  | { screen: 'record'; from: 'coach' | 'saved' }
  | { screen: 'replay'; sessionId: string; backLabel: string }
  | { screen: 'demo'; backLabel: string }
  | { screen: 'compare'; backLabel: string; shot?: { sessionId: string; shotNumber: number } }
  | { screen: 'auth'; mode: EntryMode; email?: string; recoveryError?: string; switching?: boolean; fromCoach?: boolean };

type StoreState = { store: PracticeStore } | { error: true } | null;

const preferences = new SQLiteStorage('peek-preferences');
const coachRoute: Route = { screen: 'coach' };
const accountRoute: Route = { screen: 'account' };
const guestKey = 'completed-welcome';
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
    [fonts.display]: Poppins_800ExtraBold,
    [fonts.regular]: Poppins_400Regular,
    [fonts.semibold]: Poppins_600SemiBold,
    [fonts.serif]: Lora_400Regular,
    [fonts.serifBold]: Lora_700Bold,
    [fonts.italic]: Lora_700Bold_Italic,
    [fonts.mono]: IBMPlexMono_400Regular,
    [fonts.monoBold]: IBMPlexMono_700Bold,
    [fonts.player]: BarlowCondensed_700Bold,
  });
  const [database, setDatabase] = useState<StoreState>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [splashDone, setSplashDone] = useState(false);
  const finishSplash = useCallback(() => setSplashDone(true), []);
  const ready = !!database && (fontsReady || !!fontError);

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
    <SafeAreaProvider style={styles.root} initialMetrics={initialWindowMetrics}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root}>
        {ready && database && ('error' in database ? (
          <View style={styles.middle}>
            <Notice>Practice history could not be opened.</Notice>
            <Button label="Retry" onPress={() => {
              setDatabase(null);
              setStartupAttempt((attempt) => attempt + 1);
            }} />
          </View>
        ) : <PracticeApp store={database.store} />)}
        {!splashDone || !ready ? <Splash play={ready && !splashDone} onEnd={finishSplash} /> : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function PracticeApp({ store }: { store: PracticeStore }) {
  const [stack, setStack] = useState<Route[]>([]);
  const [menu, setMenu] = useState(false);
  const [seenWelcome, setSeenWelcome] = useState<boolean>();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [selection, setSelection] = useState<{ id: string; userId: string | null }>();
  const [question, setQuestion] = useState('');
  const [resumeCoach, setResumeCoach] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [recent, setRecent] = useState<{ userId: string; values: RecentChat[] }>();
  const currentRecent = useRef(recent);
  const recoveryLink = useRef<string>(null);
  const cloudUserId = session?.user.id ?? null;
  const playerSession = session?.user.is_anonymous ? null : session;
  const playerUserId = playerSession?.user.id ?? null;
  const scheduleClipSync = useClipSync(store, cloudUserId);
  const selectedSession = selection && (selection.userId === cloudUserId || selection.userId === null)
    ? store.getSession(selection.id) ?? undefined : undefined;
  const currentRoute = stack.at(-1) ?? (session || seenWelcome ? coachRoute : { screen: 'welcome' } as const);
  const authenticatedRecent = recent && recent.userId === cloudUserId ? recent.values : [];
  const latestChat = authenticatedRecent[0];
  const showCoach = currentRoute.screen === 'coach';

  useEffect(() => {
    let alive = true;
    void preferences.getItem(guestKey).then(
      (value) => { if (alive) setSeenWelcome(value === 'yes'); },
      () => { if (alive) setSeenWelcome(false); },
    );
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const auth = supabase.auth;
    let alive = true;
    const { data: { subscription } } = auth.onAuthStateChange((event, current) => {
      setSession(event === 'INITIAL_SESSION' && !current ? storedSession() : current);
      setAuthReady(true);
      if (event === 'PASSWORD_RECOVERY') {
        setMenu(false);
        setStack([accountRoute, { screen: 'auth', mode: 'update' }]);
      }
    });

    function showRecoveryError() {
      setMenu(false);
      setStack([coachRoute, {
        screen: 'auth', mode: 'sign-in',
        recoveryError: 'This reset link is expired or was opened on a different device. Request a new link in Peek.',
      }]);
    }

    async function recover(url: string) {
      const code = passwordRecoveryCode(url);
      if (!alive || code === undefined || recoveryLink.current === url) return;
      recoveryLink.current = url;
      try {
        if (!code) {
          showRecoveryError();
          return;
        }
        const { error } = await auth.exchangeCodeForSession(code);
        if (alive && error) showRecoveryError();
      } catch {
        if (alive) showRecoveryError();
      }
    }

    void Linking.getInitialURL().then((url) => { if (url) void recover(url); }, () => {});
    const links = Linking.addEventListener('url', ({ url }) => void recover(url));
    const appState = AppState.addEventListener('change', (state) => {
      const pending = state === 'active' ? auth.startAutoRefresh() : auth.stopAutoRefresh();
      void pending.catch(() => undefined);
    });
    return () => {
      alive = false;
      subscription.unsubscribe();
      links.remove();
      appState.remove();
      void auth.stopAutoRefresh().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!playerUserId) {
      currentRecent.current = undefined;
      setRecent(undefined);
      return;
    }
    let active = true;
    void loadRecentChats(playerUserId).then((values) => {
      if (!active || currentRecent.current?.userId === playerUserId) return;
      currentRecent.current = { userId: playerUserId, values };
      setRecent(currentRecent.current);
    }, () => {});
    return () => { active = false; };
  }, [playerUserId]);

  useEffect(() => {
    if (!selection || selection.userId === cloudUserId) return;
    if (!selection.userId) {
      setSelection({ ...selection, userId: cloudUserId });
    } else {
      setSelection(undefined);
      setQuestion('');
      setGeneration((value) => value + 1);
    }
  }, [cloudUserId, selection]);

  function updateRecent(userId: string, chat: RecentChat) {
    if (userId !== playerUserId) return;
    const previous = currentRecent.current?.userId === userId ? currentRecent.current.values : [];
    const existing = previous.find(({ sessionId }) => sessionId === chat.sessionId);
    if (existing?.reply === chat.reply && existing.title === chat.title) return;
    const values = [chat, ...previous.filter(({ sessionId }) => sessionId !== chat.sessionId)]
      .sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 15);
    currentRecent.current = { userId, values };
    setRecent(currentRecent.current);
    void saveRecentChats(userId, values).catch(() => undefined);
  }

  function completeWelcome() {
    setSeenWelcome(true);
    void preferences.setItem(guestKey, 'yes').catch(() => undefined);
  }

  function go(route: Route) {
    setMenu(false);
    setStack([route]);
  }

  function push(route: Route) {
    setMenu(false);
    setStack((routes) => [...(routes.length ? routes : [currentRoute]), route]);
  }

  function back() {
    setStack((routes) => routes.length > 1 ? routes.slice(0, -1) : []);
  }

  function selectClip(clip: Session, clearQuestion = false) {
    if (clearQuestion) setQuestion('');
    setSelection({ id: clip.id, userId: cloudUserId });
    setGeneration((value) => value + 1);
    go(coachRoute);
  }

  function newChat() {
    setSelection(undefined);
    setQuestion('');
    setResumeCoach(false);
    setGeneration((value) => value + 1);
    go(coachRoute);
  }

  function openAuth(mode: EntryMode) {
    push({ screen: 'auth', mode });
  }

  function review(clip: Session, backLabel: string) {
    push({ screen: 'replay', sessionId: clip.id, backLabel });
  }

  const openMenu = () => setMenu(true);
  let content: React.ReactNode;
  switch (currentRoute.screen) {
    case 'welcome':
      content = <Welcome onSignIn={() => openAuth('sign-in')} onCreate={() => openAuth('create')}
        onGuest={() => { completeWelcome(); go(coachRoute); }} />;
      break;
    case 'auth':
      content = <AuthScreen key={currentRoute.mode + ':' + (currentRoute.email ?? '') + ':' + (currentRoute.recoveryError ?? '')}
        initialMode={currentRoute.mode} initialEmail={currentRoute.email} recoveryError={currentRoute.recoveryError}
        onBack={back} onSignedIn={(user) => {
          void rememberAccount(user).catch(() => undefined);
          if (currentRoute.fromCoach) setResumeCoach(true);
          completeWelcome();
          if (currentRoute.switching || currentRoute.mode === 'update') go(accountRoute);
          else if (stack.at(-2)?.screen === 'welcome') go(coachRoute);
          else back();
        }} />;
      break;
    case 'account':
      content = <AccountScreen session={playerSession} latestChat={latestChat} onMenu={openMenu}
        onSwitch={() => push({ screen: 'switch' })} onAuth={openAuth}
        onChat={() => {
          const clip = latestChat && store.getSession(latestChat.sessionId);
          if (clip) selectClip(clip, true);
          else go(coachRoute);
        }} />;
      break;
    case 'switch':
      content = <SwitchAccount session={playerSession} onBack={back}
        onSelect={(email) => push({ screen: 'auth', mode: 'sign-in', email, switching: true })} />;
      break;
    case 'saved':
      content = <SavedClips store={store} onMenu={openMenu} onRecord={() => push({ screen: 'record', from: 'saved' })}
        onReplay={(clip) => review(clip, 'Saved clips')} />;
      break;
    case 'record':
      content = <RecordScreen store={store} cloudUserId={playerUserId} onBack={back}
        onSaved={(clip) => {
          if (currentRoute.from === 'coach') selectClip(clip);
          else setStack((routes) => [...routes.slice(0, -1), { screen: 'replay', sessionId: clip.id, backLabel: 'Saved clips' }]);
        }} />;
      break;
    case 'picker':
      content = <ClipPicker store={store} userId={playerUserId} onSelect={selectClip} onCancel={back} />;
      break;
    case 'replay': {
      const clip = store.getSession(currentRoute.sessionId);
      content = clip ? (
        <ReplayScreen key={clip.id} store={store} cloudUserId={cloudUserId} initialSession={clip}
          backLabel={currentRoute.backLabel} onBack={back} onShotsChanged={scheduleClipSync}
          onViewDemo={() => push({ screen: 'demo', backLabel: 'Session details' })}
          onCompare={(shotNumber) => push({
            screen: 'compare', backLabel: 'Session details', shot: { sessionId: clip.id, shotNumber },
          })}
          onAskCoach={(item) => selectClip(item, true)} />
      ) : <Page><Notice>This session is no longer available.</Notice><Button label="Back" onPress={back} /></Page>;
      break;
    }
    case 'demo':
      content = <DemoScreen store={store} backLabel={currentRoute.backLabel} onBack={back}
        onCompare={() => push({ screen: 'compare', backLabel: '3D example' })} />;
      break;
    case 'compare':
      content = <ComparisonScreen backLabel={currentRoute.backLabel} onBack={back}
        source={currentRoute.shot ? { ...currentRoute.shot, userId: cloudUserId } : undefined}
        playerName={playerSession ? accountName(playerSession.user) : undefined}
        onBrowseClips={() => go({ screen: 'saved' })} />;
      break;
    case 'coach':
      break;
  }

  if (!authReady || seenWelcome === undefined) return <Splash />;

  const knownConversations: MenuChat[] = cloudUserId && menu
    ? authenticatedRecent.flatMap(({ sessionId, title }) => {
        const clip = store.getSession(sessionId);
        return clip ? [{ session: clip, title }] : [];
      })
    : [];

  return (
    <>
      {currentRoute.screen !== 'welcome' ? (
        <View style={showCoach ? styles.fill : styles.hidden}>
          <CoachScreen key={(playerUserId ?? 'guest') + ':' + String(generation)} visible={showCoach}
            store={store} userId={cloudUserId} session={selectedSession} question={question} onChangeQuestion={setQuestion}
            onMenu={openMenu} onNewChat={newChat} onRecord={() => push({ screen: 'record', from: 'coach' })}
            onPickClip={() => push({ screen: 'picker' })} onRemoveClip={() => setSelection(undefined)}
            onReview={(clip) => review(clip, 'Coach')}
            onSignIn={() => push({ screen: 'auth', mode: 'sign-in', fromCoach: true })}
            onGuestConnect={startGuestSession} onSync={scheduleClipSync} onRecent={updateRecent}
            resumeAfterSignIn={resumeCoach} onResume={() => setResumeCoach(false)} />
        </View>
      ) : null}
      {content}
      <Menu visible={menu} session={playerSession} chats={knownConversations} onDismiss={() => setMenu(false)}
        onNewChat={newChat} onSaved={() => go({ screen: 'saved' })} onDemo={() => push({ screen: 'demo', backLabel: 'Back' })}
        onCompare={() => push({ screen: 'compare', backLabel: 'Back' })}
        onAccount={() => go(accountRoute)} onSwitch={() => { setMenu(false); setStack([accountRoute, { screen: 'switch' }]); }}
        onChat={(clip) => selectClip(clip, true)} onSignIn={() => openAuth('sign-in')} />
    </>
  );
}

function Welcome({ onSignIn, onCreate, onGuest }: { onSignIn: () => void; onCreate: () => void; onGuest: () => void }) {
  const { width } = useWindowDimensions();
  const fontSize = width < 375 ? 42 : 47;
  const type = { fontSize, lineHeight: fontSize + 5 };
  return (
    <Page style={styles.welcome}>
      <Brand size={44} wordmark />
      <View style={styles.hero}>
        <Text style={[styles.heroTitle, type]} accessibilityRole="header">
          See your shot{'\n'}from a new{'\n'}<Text style={styles.heroEmphasis}>angle.</Text>
        </Text>
        <Divider />
        <Text style={styles.heroCopy}>Record, replay, and learn from{'\n'}each shot.</Text>
      </View>
      <View style={styles.welcomeActions}>
        <Button label="Sign in" onPress={onSignIn} arrow />
        <Button label="Create account" kind="secondary" onPress={onCreate} arrow />
      </View>
      <TextButton label="Continue as guest" onPress={onGuest} style={styles.guest} />
    </Page>
  );
}

type MenuChat = { session: Session; title: string };

function Menu({ visible, session, chats, onDismiss, onNewChat, onSaved, onDemo, onCompare, onAccount, onSwitch, onChat, onSignIn }: {
  visible: boolean;
  session: AuthSession | null;
  chats: MenuChat[];
  onDismiss: () => void;
  onNewChat: () => void;
  onSaved: () => void;
  onDemo: () => void;
  onCompare: () => void;
  onAccount: () => void;
  onSwitch: () => void;
  onChat: (clip: Session) => void;
  onSignIn: () => void;
}) {
  const name = session ? accountName(session.user) : 'Guest';
  return (
    <Modal animationType="fade" visible={visible} transparent onRequestClose={onDismiss}>
      <View style={styles.drawerOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} accessible={false} />
        <SafeAreaView style={styles.drawer} accessibilityViewIsModal>
          <View style={styles.drawerHeader}>
            <Brand size={44} wordmark />
            <IconButton icon="close" label="Close menu" style={styles.close} onPress={onDismiss} />
          </View>
          <Pressable accessibilityRole="button" onPress={onNewChat} style={({ pressed }) => [styles.newChat, pressed && styles.dimmed]}>
            <Icon name="menuPlus" /><Text style={styles.newChatText}>New chat</Text>
          </Pressable>
          <ScrollView style={styles.fill} contentContainerStyle={styles.drawerLinks}>
            <Text style={styles.sectionLabel}>LIBRARY</Text>
            <MenuItem title="Saved clips" icon="library" onPress={onSaved} />
            <MenuItem title="NBA comparison" onPress={onCompare} />
            <MenuItem title="3D example" onPress={onDemo} />
            <Text style={[styles.sectionLabel, styles.recentLabel]}>RECENTS</Text>
            {session ? (
              chats.length ? chats.map((chat) => (
                <MenuItem key={chat.session.id} title={chat.title} onPress={() => onChat(chat.session)} />
              )) : <Text style={styles.noRecent}>No conversations yet</Text>
            ) : <MenuItem title="Sign in to see your chat history" icon="lock" boxed onPress={onSignIn} />}
          </ScrollView>
          <View style={styles.accountLink}>
            <Pressable accessibilityRole="button" accessibilityLabel={session ? 'View profile' : 'Guest account'}
              onPress={onAccount} style={({ pressed }) => [styles.profile, pressed && styles.dimmed]}>
              <View style={styles.initial}><Text style={styles.initialText}>{session ? name.slice(0, 1).toUpperCase() : '?'}</Text></View>
              <View style={styles.fill}>
                <Text style={styles.accountName} numberOfLines={1}>{name}</Text>
                <Text style={styles.accountMessage} numberOfLines={1}>{session ? 'View profile' : 'Sign in or create an account'}</Text>
              </View>
            </Pressable>
            {session ? <IconButton icon="switch" label="Switch account" style={styles.close} onPress={onSwitch} /> : null}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function MenuItem({ title, icon, boxed, onPress }: {
  title: string; icon?: 'library' | 'lock'; boxed?: boolean; onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => [styles.menuItem, boxed && styles.menuItemBox, pressed && styles.dimmed]}>
      {icon ? <Icon name={icon} /> : null}
      <Text style={icon === 'library' ? styles.accountName : styles.menuText} numberOfLines={1}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
  hidden: { display: 'none' },
  middle: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  welcome: { flexGrow: 1, paddingTop: 8, gap: 13, paddingBottom: 24 },
  hero: { gap: 12 },
  heroTitle: { color: colors.text, fontFamily: fonts.serifBold, letterSpacing: -0.7 },
  heroEmphasis: { fontFamily: fonts.italic },
  heroCopy: { ...ui.serif, marginTop: 13 },
  welcomeActions: { gap: 21, marginTop: 27 },
  guest: { marginTop: 'auto', marginBottom: 7 },
  drawerOverlay: { flex: 1, backgroundColor: '#000a' },
  drawer: {
    flex: 1, width: '79%', maxWidth: 334, backgroundColor: colors.drawer, borderRightWidth: 1, borderRightColor: colors.border,
    borderTopRightRadius: 23, borderBottomRightRadius: 23, paddingHorizontal: 14, overflow: 'hidden',
  },
  drawerHeader: { ...ui.row, paddingLeft: 6, marginTop: 3, marginBottom: 14, minHeight: 46 },
  close: { backgroundColor: colors.surface, minWidth: 38, minHeight: 38, borderRadius: 19 },
  newChat: {
    backgroundColor: colors.accent, borderRadius: 26, paddingHorizontal: 14, minHeight: 46,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  newChatText: { ...ui.text, color: colors.white, fontFamily: fonts.semibold, fontSize: 15 },
  drawerLinks: { paddingTop: 11, paddingBottom: 10 },
  sectionLabel: { ...ui.mono, color: colors.muted, fontSize: 10, paddingHorizontal: 8, paddingBottom: 3 },
  recentLabel: { marginTop: 12 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 11, borderRadius: 11, paddingHorizontal: 10, minHeight: 42 },
  menuItemBox: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  menuText: { ...ui.body, flexShrink: 1 },
  noRecent: { ...ui.body, padding: 10 },
  accountLink: {
    flexDirection: 'row', alignItems: 'center', gap: 5, padding: 6, paddingRight: 8, marginBottom: 4,
    borderRadius: 16, borderColor: colors.border, borderWidth: 1, backgroundColor: colors.surface,
  },
  profile: { flex: 1, minHeight: 43, flexDirection: 'row', alignItems: 'center', paddingLeft: 4, gap: 10 },
  initial: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.selected, justifyContent: 'center', alignItems: 'center' },
  initialText: { ...ui.text, color: colors.note, fontFamily: fonts.semibold },
  accountName: { ...ui.text, fontFamily: fonts.semibold, flexShrink: 1 },
  accountMessage: { ...ui.body, fontSize: 12 },
  dimmed: { opacity: 0.65 },
});
