import { fetch as expoFetch } from 'expo/fetch';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { ComponentRef } from 'react';
import {
  Keyboard, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CoachMessage } from '../../mobile/src/core/apiClient';

import { apiUrl } from './api';
import { accessToken } from './auth';
import { createSessionCoach, maxCoachQuestionLength } from './coach';
import type { RecentChat } from './coach';
import type { PracticeStore } from './database';
import { localVideoUri } from './device-storage';
import { getShotAnalysisState } from './guest-pose';
import { withShootingHand } from './guest-pose-motion';
import { ThinkingDots } from './PeekMotion';
import { clipTime, sessionTime, type Session } from './practice';
import { ShotAnalysisProgress } from './ShotAnalysisProgress';
import { Brand, Chip, colors, fonts, gradients, Icon, IconButton, message, Notice, TopBar, ui } from './ui';

const prompts = [
  { label: 'Analyze my shot', question: 'Can you analyze this shot and give me two things to work on?' },
  { label: 'Compare me to Curry', question: 'How does my release compare to Steph Curry’s?' },
  { label: 'Why do I miss short?', question: 'What might explain why my shots fall short?' },
  { label: 'Fix my release', question: 'What should I change about my release?' },
];

const caption = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, '$1').trim();

type CoachSubmission = { text: string; retryDraft?: string; edited: boolean };

export function CoachScreen({
  store, userId, conversationId, session, question, onChangeQuestion, onMenu, onNewChat, onRecord, onPickClip,
  onRemoveClip, onReview, onSignIn, onGuestConnect, onSync, guestLimit, onRecent, visible, resumeAfterSignIn, onResume,
}: {
  store: PracticeStore;
  userId: string | null;
  conversationId: string;
  session?: Session;
  question: string;
  onChangeQuestion: (text: string) => void;
  onMenu: () => void;
  onNewChat: () => void;
  onRecord: () => void;
  onPickClip: () => void;
  onRemoveClip: () => void;
  onReview: (session: Session) => void;
  onSignIn: () => void;
  onGuestConnect: () => Promise<string>;
  onSync: () => void;
  guestLimit?: string;
  onRecent: (userId: string, chat: RecentChat) => void;
  visible: boolean;
  resumeAfterSignIn: boolean;
  onResume: () => void;
}) {
  const { top } = useSafeAreaInsets();
  const [history, setHistory] = useState<CoachMessage[]>();
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState('');
  const [writing, setWriting] = useState('');
  const [status, setStatus] = useState('Looking at your shot…');
  const [notice, setNotice] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const [queued, setQueued] = useState<CoachSubmission>();
  const [submitted, setSubmitted] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [, setRevision] = useState(0);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const activeTurn = useRef<AbortController>(null);
  const submission = useRef<CoachSubmission>(null);
  const sessionId = session?.id ?? conversationId;
  const cloud = userId && session ? store.sessionCloudShots(userId, session.id) : [];
  const syncing = cloud.some(({ state }) => state === 'pending');
  const ready = cloud.some(({ state }) => state === 'synced' || state === 'dirty');
  const tagged = !!session && (!!cloud.length || store.listShots(session.id).length > 0);
  const client = useMemo(() => userId
    ? createSessionCoach(apiUrl, sessionId, (renew) => accessToken(userId, renew), expoFetch)
    : undefined, [sessionId, userId]);

  const saveLoadedChat = useEffectEvent((messages: CoachMessage[]) => {
    const first = messages.find(({ role }) => role === 'user');
    const last = messages.findLast(({ role }) => role === 'assistant');
    if (userId && first && last) {
      const timestamp = Date.parse(messages.at(-1)?.createdAt ?? '');
      onRecent(userId, {
        sessionId,
        title: chatTitle(first.text),
        reply: caption(last.text).slice(0, 1000),
        updatedAt: Number.isFinite(timestamp) ? timestamp : (session?.createdAt ?? Date.now()),
      });
    }
  });

  useEffect(() => {
    setHistory(undefined);
    setNotice(undefined);
    if (!client) return;
    const request = new AbortController();
    void client.history(request.signal).then((messages) => {
      if (!request.signal.aborted) {
        setHistory(messages);
        saveLoadedChat(messages);
      }
    }, (error) => {
      if (!request.signal.aborted) setNotice(message(error, 'Could not load the conversation.'));
    });
    return () => {
      request.abort();
      activeTurn.current?.abort();
    };
  }, [client, attempt]);

  useEffect(() => {
    if (!visible || !syncing) return;
    const timer = setInterval(() => setRevision((n) => n + 1), 1500);
    return () => clearInterval(timer);
  }, [visible, syncing]);

  useEffect(() => {
    if (!visible) setAttachOpen(false);
  }, [visible]);

  useEffect(() => () => { submission.current = null; }, []);

  function finishSubmission(turn: CoachSubmission, retry = false) {
    if (submission.current !== turn) return;
    submission.current = null;
    setQueued(undefined);
    setSubmitted('');
    if (retry && !turn.edited && turn.retryDraft !== undefined) onChangeQuestion(turn.retryDraft);
  }

  async function send(value: string) {
    const text = value.trim();
    if (!text || submission.current) return;
    const fromDraft = value === question;
    const turn = { text, retryDraft: fromDraft || !question ? value : undefined, edited: false };
    submission.current = turn;
    setNotice(undefined);
    setAttachOpen(false);
    if (fromDraft) onChangeQuestion('');
    setSubmitted(text);
    let owner = userId;
    if (!userId) {
      setConnecting(true);
      try {
        owner = await onGuestConnect();
      } catch (error) {
        setNotice(message(error, 'Could not start Coach in guest mode.'));
        finishSubmission(turn, true);
        return;
      } finally {
        setConnecting(false);
      }
    }
    if (submission.current !== turn) return;
    if (!owner) {
      finishSubmission(turn, true);
      return;
    }
    if (session && tagged) {
      try {
        store.prepareAnalysis(session.id, owner);
        setRevision((n) => n + 1);
        onSync();
      } catch {
        // A locally available analysis can still provide context without a synced clip.
      }
    }
    if (client && history) {
      void deliver(turn);
    } else {
      setQueued(turn);
    }
  }

  async function deliver(turn: CoachSubmission) {
    if (!userId || !client || !history || activeTurn.current || submission.current !== turn) return;
    const { text } = turn;
    setQueued(undefined);
    setNotice(undefined);
    const request = new AbortController();
    activeTurn.current = request;
    const shot = session && getShotAnalysisState(session.id)?.result;
    const declaredHand = session ? store.getShootingHand(session.id) : null;
    const pose = shot && withShootingHand(shot.pose, declaredHand);
    const onDeviceShot = shot && pose ? {
      releaseMs: shot.releaseMs,
      shootingHand: pose.shootingHand,
      ...pose.metrics,
    } : undefined;
    setStatus(onDeviceShot || ready ? 'Looking at your shot…' : 'Thinking…');
    setPending(text);
    setWriting('');
    let retry = false;
    try {
      const reply = await client.ask(text, request.signal, (update) => {
        if (request.signal.aborted) return;
        setWriting('');
        setStatus(update);
      }, (piece) => {
        if (!request.signal.aborted) setWriting((current) => current + piece);
      }, onDeviceShot, declaredHand ?? undefined);
      if (request.signal.aborted) return;
      const next = [...history, { id: null, text, role: 'user', createdAt: new Date().toISOString() } satisfies CoachMessage, reply];
      setHistory(next);
      const first = next.find(({ role }) => role === 'user')?.text ?? text;
      onRecent(userId, {
        sessionId,
        title: chatTitle(first),
        reply: caption(reply.text).slice(0, 1000),
        updatedAt: Date.now(),
      });
    } catch (error) {
      if (!request.signal.aborted) {
        retry = true;
        setNotice(message(error, 'Could not reach Coach. Try again.'));
      }
    } finally {
      if (activeTurn.current === request) activeTurn.current = null;
      if (submission.current === turn) {
        setPending('');
        setWriting('');
        finishSubmission(turn, retry);
      }
    }
  }

  const deliverQueued = useEffectEvent((turn: CoachSubmission) => void deliver(turn));
  useEffect(() => {
    if (visible && client && history && queued) deliverQueued(queued);
  }, [visible, client, history, queued]);
  const resume = useEffectEvent(() => {
    onResume();
    if (question.trim()) void send(question);
  });
  useEffect(() => {
    if (visible && userId && resumeAfterSignIn) resume();
  }, [visible, userId, resumeAfterSignIn]);
  function startAttachment(action: () => void) {
    setAttachOpen(false);
    Keyboard.dismiss();
    action();
  }

  const messages = history ?? [];
  const busy = !!pending || connecting || !!queued;
  const firstQuestion = messages.find(({ role }) => role === 'user');
  const hasMessages = !!(messages.length || pending || submitted);
  const attached = !!session && !messages.length && !pending && !submitted;
  const promptList = attached ? prompts.slice(0, 2) : prompts;
  const title = firstQuestion ? chatTitle(firstQuestion.text) : hasMessages ? 'New chat' : 'Coach';
  const videoRemoved = !!session && !localVideoUri(session.videoPath);
  const syncLimit = syncing && !ready ? guestLimit : undefined;

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={top} style={styles.fill} enabled={visible}>
      <TopBar onMenu={onMenu}
        center={
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
            {!hasMessages ? <View style={styles.ai}><Text style={styles.aiText}>AI</Text></View> : null}
          </View>
        }
        trailing={<IconButton icon="newChat" label="New chat" onPress={onNewChat}
          disabled={connecting || (!hasMessages && !session && !question)} />}
      />
      {hasMessages ? (
        <ScrollView ref={scroll} style={styles.fill} contentContainerStyle={styles.messages}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
          <Text style={styles.threadDate}>
            {firstQuestion?.createdAt ? sessionTime(Date.parse(firstQuestion.createdAt)).toUpperCase() : 'JUST NOW'}
          </Text>
          {session && (messages.length > 0 || pending || submitted) ? (
            <View style={styles.threadClip}>
              <ClipCover duration={session.durationMs} removed={videoRemoved} label="Open practice clip"
                onPress={() => onReview(session)} />
              {visible ? <ShotAnalysisProgress sessionId={session.id} style={styles.threadAnalysis} /> : null}
            </View>
          ) : null}
          {messages.map((entry, index) => entry.role === 'assistant'
            ? <CoachReply key={entry.id ?? index} text={entry.text} />
            : <UserBubble key={entry.id ?? index} text={entry.text} />)}
          {pending ? (
            <>
              <UserBubble text={pending} />
              <CoachReply text={writing || status} thinking={!writing} />
            </>
          ) : submitted ? <UserBubble text={submitted} /> : null}
          {session && messages.length > 0 && !pending ? (
            <View style={styles.actions}>
              <Chip label="Open session" onPress={() => onReview(session)} />
              {!videoRemoved ? <Chip label="Mark makes & misses" onPress={() => onReview(session)} /> : null}
            </View>
          ) : null}
        </ScrollView>
      ) : (
        <ScrollView style={styles.fill} contentContainerStyle={styles.greetingPage} keyboardShouldPersistTaps="handled">
          <View style={styles.greeting}>
            <Brand size={56} />
            <Text style={styles.greetingTitle} accessibilityRole="header">How’s your shot{'\n'}today?</Text>
            <Text style={styles.greetingCopy}>Ask a question or attach a clip for tips on your shooting form.</Text>
          </View>
        </ScrollView>
      )}

      {attachOpen ? <Pressable accessible={false} onPress={() => setAttachOpen(false)} style={styles.scrim} /> : null}
      <View style={[styles.footer, attachOpen && styles.footerOpen]}>
        {notice || syncLimit ? (
          <View style={styles.feedback}>
            <Notice>{notice ?? syncLimit}</Notice>
            {notice && client && !history ? <Chip label="Retry conversation" onPress={() => setAttempt(attempt + 1)} /> : null}
          </View>
        ) : null}
        {!userId && notice ? <View style={styles.actions}><Chip label="Sign in" onPress={onSignIn} /></View> : null}
        {!syncLimit && (connecting || syncing && !ready || queued && !notice) ? (
          <Text accessibilityLiveRegion="polite" style={styles.status}>
            {connecting ? 'Connecting to Coach…' : syncing ? 'Syncing your shot with Coach…' : 'Opening your conversation…'}
          </Text>
        ) : null}
        {!hasMessages ? (
          <View style={styles.suggestions}>
            {promptList.map(({ label, question: prompt }) => (
              <View style={styles.suggestion} key={label}><Chip label={label} onPress={() => void send(prompt)} /></View>
            ))}
          </View>
        ) : null}
        <View style={[styles.composer, attached && styles.composerWithClip]}>
          {attached && session ? (
            <View style={styles.attachmentRow}>
              <View style={styles.attachPreview}>
                <ClipCover compact duration={session.durationMs} removed={videoRemoved}
                  label="Review attached clip" onPress={() => onReview(session)} />
                <IconButton icon="remove" label="Remove attachment" style={styles.remove} disabled={busy} onPress={() => {
                  if (submission.current) return;
                  setNotice(undefined);
                  setQueued(undefined);
                  setSubmitted('');
                  onRemoveClip();
                }} />
              </View>
              {visible ? <ShotAnalysisProgress sessionId={session.id} style={styles.inlineAnalysis} /> : null}
            </View>
          ) : null}
          <View style={styles.inputRow}>
            <IconButton icon={attachOpen ? 'closeAccent' : 'plus'} label={attachOpen ? 'Close attachments' : 'Add clip'}
              onPress={() => {
                if (submission.current) return;
                Keyboard.dismiss();
                setAttachOpen(!attachOpen);
              }} disabled={busy} style={[styles.round, styles.attach]} />
            <TextInput style={styles.input} placeholder="Ask Coach about your shot…" placeholderTextColor={colors.muted}
              accessibilityLabel="Ask Coach about your shot" multiline value={question}
              maxLength={maxCoachQuestionLength} onChangeText={(text) => {
                if (submission.current) submission.current.edited = true;
                onChangeQuestion(text);
              }}
              onFocus={() => setAttachOpen(false)} />
            <IconButton icon="send" label="Send to Coach" onPress={() => void send(question)}
              disabled={!question.trim() || busy || !!client && !history}
              style={[styles.round, question.trim() ? styles.sendActive : styles.attach]} />
          </View>
        </View>
        {attachOpen ? (
          <View style={styles.attachOverlay} accessibilityViewIsModal>
            <View style={styles.attachMenu}>
              <AttachAction icon="camera" label="Camera" onPress={() => startAttachment(onRecord)} />
              <AttachAction icon="upload" label="Upload clip" onPress={() => startAttachment(onPickClip)} />
            </View>
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function chatTitle(text: string) {
  if (text === prompts[1]?.question) return 'Release vs. Curry';
  return text.replace(/\s+/g, ' ').slice(0, 58);
}

function AttachAction({ icon, label, onPress }: { icon: 'camera' | 'upload'; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => [styles.attachAction, pressed && styles.dimmed]}>
      <View style={styles.attachBadge}><Icon name={icon} /></View>
      <Text style={styles.headerTitle}>{label}</Text>
    </Pressable>
  );
}

function UserBubble({ text }: { text: string }) {
  return <View style={styles.userBubble}><Text style={styles.replyText}>{text}</Text></View>;
}

function CoachReply({ text, thinking }: { text: string; thinking?: boolean }) {
  return (
    <View style={styles.reply}>
      <View style={styles.byline}><Brand size={22} /><Text style={ui.label}>COACH</Text></View>
      {thinking ? (
        <View style={styles.thinking} accessibilityLiveRegion="polite">
          <ThinkingDots /><Text style={ui.body}>{caption(text)}</Text>
        </View>
      ) : <Text style={styles.replyText}>{caption(text)}</Text>}
    </View>
  );
}

export function ClipCover({ duration, removed, compact, label, onPress }: {
  duration: number; removed?: boolean; compact?: boolean; label: string; onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.clipPressable, compact && styles.clipCompact, pressed && styles.dimmed]}>
      <LinearGradient colors={removed ? gradients.media : gradients.clip} style={styles.clipCard}>
        <View style={[styles.play, compact && styles.playCompact]}>
          <Icon name={removed ? (compact ? 'videoOff' : 'clipOff') : 'play'} />
        </View>
        <View style={styles.clipMeta}>
          {!compact ? <Text style={styles.clipText}>{removed ? 'VIDEO REMOVED' : 'CATCH-AND-SHOOT'}</Text> : null}
          {!removed ? <Text style={styles.clipText}>{clipTime(duration)}</Text> : null}
        </View>
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  dimmed: { opacity: 0.65 },
  headerCenter: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerTitle: { ...ui.title, fontSize: 16, flexShrink: 1 },
  ai: { borderRadius: 5, backgroundColor: colors.selected, paddingHorizontal: 6, paddingVertical: 1 },
  aiText: { ...ui.label, fontSize: 10 },
  greetingPage: { flexGrow: 1, justifyContent: 'flex-start' },
  greeting: { alignItems: 'center', paddingHorizontal: 24, paddingTop: '25%', paddingBottom: 16, gap: 18 },
  greetingTitle: { color: colors.text, fontFamily: fonts.serif, fontSize: 27, lineHeight: 34, textAlign: 'center' },
  greetingCopy: { ...ui.body, fontSize: 13, textAlign: 'center', maxWidth: 250 },
  footer: { paddingHorizontal: 24, paddingBottom: 2, gap: 12 },
  footerOpen: { zIndex: 2 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 7 },
  suggestion: { flexBasis: '48%', flexGrow: 1, minWidth: 125 },
  composer: { backgroundColor: colors.input, borderRadius: 30, padding: 7, borderWidth: 1, borderColor: colors.border, gap: 6 },
  composerWithClip: { borderRadius: 24 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  input: {
    flex: 1, minHeight: 40, maxHeight: 116, paddingVertical: 9, paddingHorizontal: 4,
    color: colors.text, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20,
  },
  round: { minWidth: 40, minHeight: 40, borderRadius: 20 },
  attach: { backgroundColor: colors.selected },
  sendActive: { backgroundColor: colors.accent },
  messages: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 12 },
  threadDate: { ...ui.mono, fontSize: 10, alignSelf: 'center', marginBottom: 4 },
  threadClip: { width: '60%', alignSelf: 'flex-end', marginBottom: -6 },
  threadAnalysis: { marginTop: 6 },
  userBubble: { maxWidth: '76%', alignSelf: 'flex-end', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 19, backgroundColor: colors.input },
  reply: { gap: 9, paddingTop: 3 },
  byline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  replyText: { ...ui.text, fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  feedback: { gap: 6, alignItems: 'flex-start' },
  status: { ...ui.label, marginBottom: 2 },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  attachPreview: { alignSelf: 'flex-start', width: 78 },
  inlineAnalysis: { flex: 1, marginRight: 8 },
  clipPressable: { aspectRatio: 1.62, overflow: 'hidden', borderRadius: 16 },
  clipCompact: { aspectRatio: 1, borderRadius: 13 },
  clipCard: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  play: { width: 40, height: 40, backgroundColor: '#0d0a09aa', borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  playCompact: { backgroundColor: 'transparent' },
  clipMeta: { position: 'absolute', bottom: 7, left: 9, right: 9, flexDirection: 'row', justifyContent: 'space-between' },
  clipText: { ...ui.mono, color: colors.text, fontSize: 9 },
  remove: { position: 'absolute', right: 0, top: 0, borderRadius: 11, minWidth: 22, minHeight: 22, backgroundColor: colors.text },
  attachOverlay: { position: 'absolute', left: 0, right: 0, bottom: 70, zIndex: 2 },
  scrim: { ...StyleSheet.absoluteFill, bottom: 64, backgroundColor: '#0005', zIndex: 1 },
  attachMenu: {
    alignSelf: 'flex-start', marginLeft: 24, backgroundColor: colors.input, borderColor: colors.border,
    borderWidth: 1, borderRadius: 18, width: 196, paddingHorizontal: 10, paddingVertical: 5,
  },
  attachAction: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 12 },
  attachBadge: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.selected, alignItems: 'center', justifyContent: 'center' },
});
