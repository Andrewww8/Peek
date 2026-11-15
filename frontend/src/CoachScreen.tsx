import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, StyleSheet, Text, TextInput } from 'react-native';
import type { CoachMessage } from '../../mobile/src/core/apiClient';
import { apiUrl } from './api';
import { accessToken } from './auth';
import { createSessionCoach, maxCoachQuestionLength } from './coach';
import type { PracticeStore } from './database';
import { DRILL_NAME, sessionDate, type Session } from './practice';
import { Button, colors, fonts, Loading, message, Notice, Page, Panel, ScreenHeader, ui } from './ui';

export function CoachSessions({ store, userId, onSignIn, onRecord, onSelect }: {
  store: PracticeStore;
  userId: string | null;
  onSignIn: () => void;
  onRecord: () => void;
  onSelect: (session: Session) => void;
}) {
  const sessions = userId ? store.listCoachSessions(userId) : [];
  return (
    <Page>
      <Text style={ui.heading} accessibilityRole="header">Coach</Text>
      {userId ? (
        sessions.length ? (
          <Panel>
            <Text style={ui.title}>Choose a practice session</Text>
            {sessions.map((session) => (
              <Button key={session.id} label={sessionDate(session.createdAt)} kind="secondary" arrow onPress={() => onSelect(session)} />
            ))}
          </Panel>
        ) : (
          <Panel>
            <Text style={ui.body}>Record a practice session while signed in and tag a shot from Replay to ask Coach about it.</Text>
            <Button label="Record practice" onPress={onRecord} />
          </Panel>
        )
      ) : (
        <Panel>
          <Text style={ui.body}>Sign in to ask Coach about your synced basketball clips.</Text>
          <Button label="Sign in" onPress={onSignIn} />
        </Panel>
      )}
    </Page>
  );
}

export function CoachChat({ userId, session, onBack, onReplay }: {
  userId: string;
  session: Session;
  onBack: () => void;
  onReplay: () => void;
}) {
  const client = useMemo(() => createSessionCoach(apiUrl, session.id, (renew) => accessToken(userId, renew)), [session.id, userId]);
  const [history, setHistory] = useState<CoachMessage[]>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState('');
  const [status, setStatus] = useState('Waiting for Coach…');
  const [notice, setNotice] = useState<string>();
  const activeTurn = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();
    void client.history(request.signal).then((messages) => {
      if (!request.signal.aborted) setHistory(messages);
    }, (error) => {
      if (!request.signal.aborted) setNotice(message(error, 'Could not load the conversation.'));
    });
    return () => {
      request.abort();
      activeTurn.current?.abort();
    };
  }, [client, loadAttempt]);

  async function send() {
    const text = question.trim();
    if (!text || !history || activeTurn.current) return;
    const request = new AbortController();
    activeTurn.current = request;
    setNotice(undefined);
    setStatus('Waiting for Coach…');
    setPending(text);
    Keyboard.dismiss();
    try {
      const reply = await client.ask(text, request.signal, (update) => {
        if (!request.signal.aborted) setStatus(update);
      });
      if (request.signal.aborted) return;
      setHistory([...history, { id: null, text, role: 'user', createdAt: null }, reply]);
      setQuestion('');
    } catch (error) {
      if (!request.signal.aborted) setNotice(message(error, 'Could not reach Coach. Try again.'));
    } finally {
      activeTurn.current = null;
      if (!request.signal.aborted) setPending('');
    }
  }

  return (
    <>
      <ScreenHeader backLabel="Coach" onBack={onBack} />
      <KeyboardAvoidingView behavior="padding" style={styles.keyboard}>
        <Page keyboardShouldPersistTaps="handled">
          <Text style={ui.heading} accessibilityRole="header">Coach</Text>
          <Panel>
            <Text style={ui.title}>{DRILL_NAME}</Text>
            <Text style={ui.body}>{sessionDate(session.createdAt)}</Text>
            <Button label="Open session" kind="secondary" onPress={onReplay} />
          </Panel>
          {history?.map(({ id, role, text }, index) => (
            <Panel key={id ?? index} emphasis={role === 'assistant'}>
              <Text style={ui.label}>{role === 'assistant' ? 'Coach' : 'You'}</Text>
              <Text style={ui.text}>{text}</Text>
            </Panel>
          ))}
          {pending ? (
            <Panel>
              <Text style={ui.label}>You</Text>
              <Text style={ui.text}>{pending}</Text>
              <Loading text={status} />
            </Panel>
          ) : null}
          {notice ? <Notice>{notice}</Notice> : null}
          {history ? (
            <Panel>
              <TextInput
                accessibilityLabel="Ask Coach about your shot"
                placeholder="Ask Coach about your shot…"
                placeholderTextColor={colors.muted}
                style={styles.input}
                multiline
                maxLength={maxCoachQuestionLength}
                editable={!pending}
                onChangeText={setQuestion}
                value={question}
              />
              <Button label="Send" disabled={!question.trim() || !!pending} onPress={send} />
            </Panel>
          ) : notice ? (
            <Button label="Retry" onPress={() => { setNotice(undefined); setLoadAttempt((value) => value + 1); }} />
          ) : <Loading text="Opening conversation…" />}
        </Page>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  input: {
    minHeight: 48, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.media, color: colors.text, fontFamily: fonts.regular, fontSize: 16,
  },
});
