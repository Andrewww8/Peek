import type { Session } from '@supabase/supabase-js';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from './auth';
import { Button, colors, fonts, Loading, message, Notice, Page, Panel, ScreenHeader, ui } from './ui';

type Mode = 'sign-in' | 'create' | 'verify';

export function AccountScreen({ session, ready, backLabel, onBack }: {
  session: Session | null;
  ready: boolean;
  backLabel: string;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [info, setInfo] = useState<string>();
  const inFlight = useRef(false);
  const normalizedEmail = email.trim().toLowerCase();

  function changeMode(next: Mode) {
    setMode(next);
    setPassword('');
    setCode('');
    setNotice(undefined);
    setInfo(undefined);
  }

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(undefined);
    setInfo(undefined);
    Keyboard.dismiss();
    try {
      await action();
    } catch (error) {
      setNotice(message(error, 'The account request could not be completed. Try again.'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function submit() {
    if (!supabase) return;
    const auth = supabase.auth;
    void run(async () => {
      if (mode === 'verify') {
        const { data, error } = await auth.verifyOtp({ email: normalizedEmail, token: code, type: 'email' });
        if (error) throw error;
        if (!data.session) throw new Error('The code could not start a session. Request another code.');
        changeMode('sign-in');
        return;
      }

      const credentials = { email: normalizedEmail, password };
      if (mode === 'create') {
        const { data, error } = await auth.signUp(credentials);
        if (error) throw error;
        changeMode(data.session ? 'sign-in' : 'verify');
        return;
      }

      const { error } = await auth.signInWithPassword(credentials);
      if (error?.code === 'email_not_confirmed') {
        changeMode('verify');
        setInfo('Enter the code from your confirmation email or request a new one.');
      } else if (error) {
        throw error;
      } else {
        changeMode('sign-in');
      }
    });
  }

  const title = session ? 'Account' : mode === 'create' ? 'Create account' : mode === 'verify' ? 'Verify email' : 'Sign in';

  return (
    <>
      <ScreenHeader backLabel={backLabel} onBack={onBack} backDisabled={busy} />
      <KeyboardAvoidingView behavior="padding" style={styles.keyboard}>
        <Page keyboardShouldPersistTaps="handled">
          <Text style={ui.heading} accessibilityRole="header">{title}</Text>
          {notice ? <Notice>{notice}</Notice> : null}
          {info ? <Text accessibilityLiveRegion="polite" style={ui.body}>{info}</Text> : null}
          {!supabase ? (
            <Notice>Account sign-in is unavailable in this build.</Notice>
          ) : !ready ? (
            <Loading text="Checking account…" />
          ) : session ? (
            <Panel>
              <Text style={ui.label}>SIGNED IN</Text>
              <Text style={ui.title}>{session.user.email ?? 'Perspective account'}</Text>
              <Button label="Sign out of this iPhone" kind="secondary" disabled={busy} onPress={() => run(async () => {
                const { error } = await supabase?.auth.signOut({ scope: 'local' }) ?? {};
                if (error && !isAuthRetryableFetchError(error)) throw error;
                changeMode('sign-in');
              })} />
            </Panel>
          ) : mode === 'verify' ? (
            <Panel>
              <Text style={ui.body}>Enter the confirmation code sent to {normalizedEmail}.</Text>
              <Text style={ui.label}>EMAIL CODE</Text>
              <TextInput
                accessibilityLabel="Email code"
                editable={!busy}
                keyboardType="number-pad"
                onChangeText={(text) => setCode(text.replace(/\D/g, ''))}
                placeholder="Enter code"
                placeholderTextColor={colors.muted}
                style={styles.field}
                textContentType="oneTimeCode"
                value={code}
              />
              <Button label={busy ? 'Checking…' : 'Verify email'} onPress={submit} disabled={busy || code.length < 6} />
              <Button label="Resend code" kind="secondary" disabled={busy} onPress={() => run(async () => {
                const { error } = await supabase?.auth.resend({ type: 'signup', email: normalizedEmail }) ?? {};
                if (error) throw error;
                setInfo('A new code was requested. Check your email.');
              })} />
              <Button label="Back to sign in" kind="secondary" onPress={() => changeMode('sign-in')} disabled={busy} />
            </Panel>
          ) : (
            <Panel>
              <Text style={ui.body}>When you record and tag shots while signed in, Perspective uploads the recording to cut short clips for your account. The server removes the full recording after cutting the clips.</Text>
              <View style={styles.fieldGroup}>
                <Text style={ui.label}>EMAIL</Text>
                <TextInput
                  accessibilityLabel="Email address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  keyboardType="email-address"
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.muted}
                  style={styles.field}
                  textContentType="emailAddress"
                  value={email}
                />
              </View>
              <View style={styles.fieldGroup}>
                <Text style={ui.label}>PASSWORD</Text>
                <TextInput
                  accessibilityLabel="Password"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  onChangeText={setPassword}
                  placeholder="Enter password"
                  placeholderTextColor={colors.muted}
                  secureTextEntry
                  style={styles.field}
                  textContentType={mode === 'create' ? 'newPassword' : 'password'}
                  value={password}
                />
              </View>
              <Button label={busy ? 'Please wait…' : title} onPress={submit} disabled={busy || !normalizedEmail.includes('@') || !password} />
              <Button label={mode === 'create' ? 'I already have an account' : 'Create account'} kind="secondary" disabled={busy}
                onPress={() => changeMode(mode === 'create' ? 'sign-in' : 'create')} />
            </Panel>
          )}
        </Page>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  fieldGroup: { gap: 6 },
  field: {
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.media,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 16,
  },
});
