import type { Session } from '@supabase/supabase-js';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';
import {
  Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import type { TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { accountName, passwordResetUrl, savedAccounts, supabase } from './auth';
import type { SavedAccount } from './auth';
import { sessionDay } from './practice';
import {
  Button, Chip, colors, fonts, Icon, IconButton, Loading, message, Notice, Page, Panel,
  ScreenHeader, Strip, TextButton, Title, TopBar, ui,
} from './ui';

export type EntryMode = 'sign-in' | 'create' | 'update';
type Mode = EntryMode | 'verify' | 'reset' | 'reset-sent';

const titles: Record<Mode, string> = {
  'sign-in': 'Sign in',
  create: 'Create account',
  verify: 'Verify your email',
  reset: 'Reset password',
  'reset-sent': 'Check your\nemail',
  update: 'New password',
};

export function AuthScreen({ initialMode, initialEmail, recoveryError, onBack, onSignedIn }: {
  initialMode: EntryMode;
  initialEmail?: string;
  recoveryError?: string;
  onBack: () => void;
  onSignedIn: (user: Session['user']) => void;
}) {
  const { top } = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState(initialEmail ?? '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(recoveryError);
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

  function goBack() {
    if (mode === 'reset' || mode === 'reset-sent' || mode === 'verify') {
      changeMode('sign-in');
    } else if (mode === 'update' && supabase) {
      const auth = supabase.auth;
      void run(async () => {
        const { error } = await auth.signOut({ scope: 'local' });
        if (error && !isAuthRetryableFetchError(error)) throw error;
        onBack();
      });
    } else {
      onBack();
    }
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
    if (!canSubmit) {
      setNotice(mode === 'verify' ? 'Enter all six digits from your email.'
        : mode === 'create' || mode === 'update' ? 'Check your details and enter a password with at least 8 characters.'
        : mode === 'reset' ? 'Enter your email address.' : 'Enter your email address and password.');
      return;
    }
    const auth = supabase.auth;
    void run(async () => {
      if (mode === 'verify') {
        const { data, error } = await auth.verifyOtp({ email: normalizedEmail, token: code, type: 'email' });
        if (error) throw error;
        if (!data.session) throw new Error('Request another code and try again.');
        onSignedIn(data.session.user);
        return;
      }
      if (mode === 'reset') {
        const { error } = await auth.resetPasswordForEmail(normalizedEmail, { redirectTo: passwordResetUrl });
        if (error) throw error;
        changeMode('reset-sent');
        return;
      }
      if (mode === 'update') {
        const { data, error } = await auth.updateUser({ password });
        if (error) throw error;
        onSignedIn(data.user);
        return;
      }

      const credentials = { email: normalizedEmail, password };
      if (mode === 'create') {
        const { data, error } = await auth.signUp({ ...credentials, options: { data: { display_name: name.trim() } } });
        if (error) throw error;
        if (data.session) onSignedIn(data.session.user);
        else changeMode('verify');
        return;
      }

      const { data, error } = await auth.signInWithPassword(credentials);
      if (error?.code === 'email_not_confirmed') {
        // Signing in sends nothing, and the code from sign-up may have expired. Send a fresh one.
        const resent = await auth.resend({ type: 'signup', email: normalizedEmail });
        changeMode('verify');
        setInfo(resent.error ? 'Tap Resend code if you need a new code.' : 'A new code was sent. Check your email.');
      } else if (error?.code === 'invalid_credentials') {
        throw new Error('That email and password didn’t match.\nTry again or reset your password.');
      } else if (error) {
        throw error;
      } else {
        onSignedIn(data.user);
      }
    });
  }

  function resendCode() {
    if (!supabase) return;
    const auth = supabase.auth;
    void run(async () => {
      const { error } = await auth.resend({ type: 'signup', email: normalizedEmail });
      if (error) throw error;
      setInfo('A new code was requested. Check your email.');
    });
  }

  const passwordForm = mode === 'sign-in' || mode === 'create' || mode === 'update';
  const emailForm = mode === 'sign-in' || mode === 'create' || mode === 'reset';
  const canSubmit = mode === 'verify' ? code.length === 6
    : mode === 'update' ? password.length >= 8
    : normalizedEmail.includes('@') && (mode === 'reset' || (mode === 'create' ? !!name.trim() && password.length >= 8 : !!password));
  const compact = mode === 'verify' || mode === 'reset' || mode === 'reset-sent';
  const submitLabel = mode === 'verify' ? 'Verify email' : mode === 'reset' ? 'Send reset link'
    : mode === 'update' ? 'Save password' : titles[mode];

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={top} style={styles.fill}>
      <ScreenHeader mark onBack={goBack} backDisabled={busy} />
      <Page style={styles.authPage} keyboardShouldPersistTaps="handled">
        <Title title={titles[mode]} />
        {mode === 'verify' ? <Text style={[ui.serif, styles.shortCopy]}>Enter the 6-digit code sent to {normalizedEmail}.</Text> : null}
        {mode === 'reset' ? <Text style={[ui.serif, styles.shortCopy]}>Enter the email address for your Peek account.</Text> : null}
        {mode === 'reset-sent' ? <Text style={[ui.serif, styles.shortCopy]}>If that email has an account, it’ll receive a password reset link.</Text> : null}

        {notice && mode === 'reset-sent' ? <Notice icon="warning">{notice}</Notice> : null}
        {info ? <Text accessibilityLiveRegion="polite" style={ui.body}>{info}</Text> : null}
        {!supabase ? <Notice>Account sign-in is unavailable in this build.</Notice> : null}

        {mode === 'reset-sent' ? (
          <Button style={styles.sendConfirmation} label="Back to sign in" arrow onPress={() => changeMode('sign-in')} />
        ) : (
          <View style={[styles.form, compact && styles.compactForm, mode === 'sign-in' && styles.signInForm]}>
            {mode === 'create' ? <Field label="Name" value={name} onChangeText={setName} editable={!busy}
              autoCapitalize="words" placeholder="Your name" textContentType="name" /> : null}
            {emailForm ? <Field label="Email address" value={email} onChangeText={setEmail} editable={!busy}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="name@example.com"
              textContentType="emailAddress" /> : null}
            {passwordForm ? <Field password label={mode === 'update' ? 'New password' : 'Password'}
              value={password} onChangeText={setPassword} editable={!busy} autoCapitalize="none" autoCorrect={false}
              placeholder={mode === 'sign-in' ? 'Your password' : 'At least 8 characters'}
              textContentType={mode === 'sign-in' ? 'password' : 'newPassword'} /> : null}
            {mode === 'verify' ? <CodeField code={code} onChange={setCode} disabled={busy} /> : null}
            {mode === 'sign-in' ? (
              <TextButton label="Forgot password?" onPress={() => changeMode('reset')} disabled={busy} style={styles.forgot} />
            ) : null}
            <Button label={busy ? (mode === 'sign-in' ? 'Signing in…' : 'Please wait…') : submitLabel}
              style={mode === 'sign-in' ? undefined : styles.submit} arrow
              onPress={submit} disabled={busy || !supabase} />
            {notice ? <Notice icon="warning">{notice}</Notice> : null}
            {mode === 'verify' ? <TextButton label="Resend code" disabled={busy || !supabase} onPress={resendCode} /> : null}
          </View>
        )}

        {mode === 'sign-in' || mode === 'create' ? (
          <View style={styles.entryFooter}>
            <Text style={ui.body}>{mode === 'sign-in' ? 'New to Peek?' : 'Already have an account?'}</Text>
            <TextButton label={mode === 'sign-in' ? 'Create account' : 'Sign in'}
              disabled={busy} onPress={() => changeMode(mode === 'sign-in' ? 'create' : 'sign-in')} />
          </View>
        ) : null}
      </Page>
    </KeyboardAvoidingView>
  );
}

function Field({ label, password, ...input }: TextInputProps & { label: string; password?: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.field}>
        <TextInput {...input} accessibilityLabel={label} placeholderTextColor={colors.muted}
          style={styles.input} secureTextEntry={!!password && !visible} maxLength={input.maxLength ?? 320} />
        {password ? <IconButton icon="eye" label={visible ? 'Hide password' : 'Show password'}
          onPress={() => setVisible(!visible)} style={visible ? styles.eyeOn : undefined} /> : null}
      </View>
    </View>
  );
}

function CodeField({ code, onChange, disabled }: { code: string; onChange: (text: string) => void; disabled: boolean }) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>Verification code</Text>
      <View style={styles.codeRow}>
        {Array.from({ length: 6 }, (_, index) => (
          <View key={index} style={[styles.codeCell, index === Math.min(code.length, 5) && styles.focusedCell]}>
            <Text style={styles.codeDigit}>{code[index] ?? '•'}</Text>
          </View>
        ))}
        <TextInput accessibilityLabel="Verification code" value={code}
          onChangeText={(value) => onChange(value.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad"
          editable={!disabled}
          textContentType="oneTimeCode" caretHidden style={styles.codeInput} />
      </View>
    </View>
  );
}

export function AccountScreen({ session, latestChat, onChat, onMenu, onAuth, onSwitch }: {
  session: Session | null;
  latestChat?: { title: string; reply: string };
  onChat: () => void;
  onMenu: () => void;
  onAuth: (mode: EntryMode) => void;
  onSwitch: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const leaving = useRef(false);

  async function signOut() {
    if (!supabase || leaving.current) return;
    leaving.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error && !isAuthRetryableFetchError(error)) throw error;
    } catch (error) {
      setNotice(message(error, 'Could not sign out. Try again.'));
    } finally {
      setBusy(false);
      leaving.current = false;
    }
  }

  return (
    <>
      <TopBar onMenu={onMenu} />
      <Page style={styles.profilePage}>
        <Strip label="PLAYER PROFILE" detail={session ? 'SIGNED IN' : 'GUEST'} />
        <View style={styles.profileTitle}><Title title="Account" /></View>
        {session ? (
          <>
            <Panel emphasis style={styles.profileCard}>
              <View style={styles.player}>
                <View style={styles.avatar}><Icon name="profile" /></View>
                <View style={styles.fill}>
                  <Text style={styles.playerName} numberOfLines={1}>{accountName(session.user)}</Text>
                  <Text style={ui.body} numberOfLines={1}>{session.user.email}</Text>
                </View>
              </View>
              <View style={styles.profileRule} />
              <Text style={ui.label}>LATEST TIPS FROM COACH</Text>
              {latestChat ? (
                <>
                  <Text style={ui.text} numberOfLines={5}>{latestChat.reply}</Text>
                  <View style={styles.start}><Chip label="Open the chat  →" onPress={onChat} /></View>
                </>
              ) : <Text style={ui.body}>Ask Coach about a synced shot to see your latest tips here.</Text>}
            </Panel>
            <Button label="Switch account" kind="secondary" arrow onPress={onSwitch} disabled={busy} />
            <Button label={busy ? 'Signing out…' : 'Sign out'} kind="secondary" arrow onPress={signOut} disabled={busy} />
          </>
        ) : (
          <>
            <Panel style={styles.guestCard}>
              <View style={styles.player}><Icon name="user" /><Text style={ui.title}>Guest player</Text></View>
              <Text style={ui.serif}>Sign in to sync clips and chat history. You can record and review as a guest.</Text>
            </Panel>
            <Button label="Sign in" arrow onPress={() => onAuth('sign-in')} />
            <Button label="Create account" kind="secondary" arrow onPress={() => onAuth('create')} />
          </>
        )}
        {notice ? <Notice>{notice}</Notice> : null}
      </Page>
    </>
  );
}

export function SwitchAccount({ session, onBack, onSelect }: {
  session: Session | null;
  onBack: () => void;
  onSelect: (email?: string) => void;
}) {
  const [accounts, setAccounts] = useState<SavedAccount[]>();
  useEffect(() => {
    let active = true;
    void savedAccounts().then((records) => {
      if (active) setAccounts(records);
    }, () => {
      if (active) setAccounts([]);
    });
    return () => { active = false; };
  }, []);

  const user = session?.user;
  const visibleAccounts = user?.email && accounts && !accounts.some(({ id }) => id === user.id)
    ? [{ id: user.id, name: accountName(user), email: user.email, lastUsed: Date.now() }, ...accounts] : accounts;

  return (
    <>
      <ScreenHeader onBack={onBack} mark />
      <Page style={styles.switchPage}>
        <Title title="Switch account" />
        {visibleAccounts?.map((account) => {
          const current = account.id === user?.id;
          return (
            <Pressable key={account.id} accessibilityRole="button" accessibilityState={{ selected: current }}
              accessibilityLabel={account.name + ', ' + account.email} onPress={() => current ? onBack() : onSelect(account.email)}
              style={({ pressed }) => pressed ? styles.pressed : undefined}>
              <Panel style={styles.switchCard}>
                <Icon name="user" />
                <View style={styles.fill}>
                  <Text style={ui.title}>{account.name}</Text>
                  <Text style={ui.body}>{account.email}</Text>
                  <Text style={[ui.mono, styles.lastUsed]}>
                    {current ? 'CURRENT · SIGNED IN' : 'LAST USED · ' + sessionDay(account.lastUsed).toUpperCase()}
                  </Text>
                </View>
                {current ? <Icon name="check" /> : null}
              </Panel>
            </Pressable>
          );
        })}
        {!visibleAccounts ? <Loading text="Loading saved accounts…" /> : null}
        <Button label="Add another account" arrow onPress={() => onSelect()} style={styles.addAccount} />
      </Page>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  authPage: { flexGrow: 1, gap: 8, paddingBottom: 28 },
  shortCopy: { maxWidth: 270, marginTop: 6 },
  form: { marginTop: 35, gap: 15 },
  compactForm: { marginTop: 14, gap: 16 },
  signInForm: { marginTop: 45, gap: 19 },
  fieldGroup: { gap: 5 },
  fieldLabel: { ...ui.text, fontFamily: fonts.semibold, fontSize: 14 },
  field: { minHeight: 51, borderRadius: 15, backgroundColor: colors.input, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  input: { flex: 1, paddingVertical: 10, color: colors.text, fontFamily: fonts.regular, fontSize: 15, minHeight: 50 },
  eyeOn: { backgroundColor: colors.selected, borderRadius: 22 },
  forgot: { alignSelf: 'flex-end', marginBottom: -6 },
  submit: { marginTop: 20 },
  sendConfirmation: { marginTop: 18 },
  entryFooter: { marginTop: 'auto', alignItems: 'center', gap: 6, paddingTop: 36 },
  codeRow: { flexDirection: 'row', gap: 5 },
  codeCell: {
    flex: 1, minHeight: 55, borderRadius: 14, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.input, alignItems: 'center', justifyContent: 'center',
  },
  focusedCell: { borderColor: colors.accent },
  codeDigit: { ...ui.text, fontSize: 21 },
  codeInput: { ...StyleSheet.absoluteFill, color: 'transparent', opacity: 0.03 },
  profilePage: { gap: 13, paddingTop: 18 },
  profileTitle: { marginTop: 17, marginBottom: 5 },
  guestCard: { marginTop: 32, marginBottom: 17, padding: 15 },
  profileCard: { borderWidth: 1, borderColor: colors.accent, padding: 16, marginBottom: 5 },
  player: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  playerName: { color: colors.text, fontFamily: fonts.player, fontSize: 30, lineHeight: 35, textTransform: 'uppercase' },
  avatar: { width: 64, height: 64, borderRadius: 32, borderWidth: 1, borderColor: colors.note, justifyContent: 'center', alignItems: 'center' },
  profileRule: { height: 1, backgroundColor: colors.accent },
  start: { alignSelf: 'flex-start' },
  switchPage: { gap: 12 },
  switchCard: { flexDirection: 'row', alignItems: 'center', gap: 15, padding: 15, minHeight: 104 },
  lastUsed: { marginTop: 8 },
  pressed: { opacity: 0.6 },
  addAccount: { marginTop: 14 },
});
