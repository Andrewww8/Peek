import NativeMaskedView from '@react-native-masked-view/masked-view';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import type { ComponentType, PropsWithChildren, ReactElement } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, useAnimatedValue, useWindowDimensions, View } from 'react-native';
import type { ViewProps } from 'react-native';

import { colors, fonts, logoAsset } from './ui';

// The package declaration still extends React Native's removed NativeMethods type.
const MaskedView = NativeMaskedView as unknown as ComponentType<PropsWithChildren<ViewProps & { maskElement: ReactElement }>>;

// Figma Splash frames 190:510 through 190:686 and their transition into Welcome.
const splashSteps = [
  { hold: 600, duration: 450 },
  { hold: 150, duration: 500 },
  { hold: 250, duration: 400 },
  { hold: 250, duration: 300 },
  { hold: 200, duration: 90 },
  { hold: 60, duration: 120 },
  { hold: 300, duration: 90 },
  { hold: 200, duration: 400, easeOut: true },
  { hold: 50, duration: 0 },
  { hold: 100, duration: 800 },
];
const brandRed = '#b32821';
const easeInOut = Easing.inOut(Easing.ease);
const steps = splashSteps.map((_, index) => index + 1);

function useReduceMotion() {
  const [reduceMotion, setReduceMotion] = useState<boolean>();
  useEffect(() => {
    let active = true;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => { if (active) setReduceMotion(value); },
      () => { if (active) setReduceMotion(false); },
    );
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduceMotion;
}

export function Splash({ play = false, onEnd }: { play?: boolean; onEnd?: () => void }) {
  const { width } = useWindowDimensions();
  const [height, setHeight] = useState(0);
  const reduceMotion = useReduceMotion();
  const stage = useAnimatedValue(0);
  const scale = Math.min(1, (width - 24) / 310);

  useEffect(() => {
    if (!play || !height || reduceMotion === undefined) return;
    if (reduceMotion) {
      onEnd?.();
      return;
    }
    stage.setValue(0);
    const animation = Animated.sequence(splashSteps.flatMap(({ hold, duration, easeOut }, index) => [
      Animated.delay(hold),
      Animated.timing(stage, {
        toValue: steps[index]!, duration,
        easing: easeOut ? Easing.out(Easing.ease) : easeInOut, useNativeDriver: true, isInteraction: false,
      }),
    ]));
    animation.start(({ finished }) => { if (finished) onEnd?.(); });
    return () => animation.stop();
  }, [height, onEnd, play, reduceMotion, stage]);

  function track(inputRange: number[], outputRange: number[]) {
    return stage.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
  }

  const upper = height * 0.447;
  const lower = height - upper;
  const curtainWidth = track([7, 8], [87 / Math.max(width, 87), 1]);
  const curtainOpacity = track([6, 7], [0, 1]);
  const curtainCenter = track([7, 8], [18, 0]);
  const upperTravel = track([9, 10], [0, -upper]);
  const lowerTravel = track([9, 10], [0, lower]);
  return (
    <View style={styles.splash} accessible accessibilityLabel="Opening Peek"
      onLayout={({ nativeEvent: { layout } }) => setHeight(layout.height)}>
      <Animated.View style={[styles.artBackdrop, { opacity: track([7.96, 8], [1, 0]) }]}>
        <View style={[styles.art, { transform: [{ translateY: -22.5 }, { scale }] }]}>
          <MaskedView style={styles.wordClip} maskElement={
            <Image source={require('../assets/peek/splashWordmarkMask.svg')} style={styles.wordMask} accessible={false} />
          }>
            <Animated.Text style={[styles.word, { transform: [{ translateX: track([0, 1], [149, -48]) }] }]}>
              eek
            </Animated.Text>
          </MaskedView>
          <Animated.View style={[styles.logoGroup, { transform: [{ translateX: track([1, 2], [0, 49]) }] }]}>
            <Image source={logoAsset} style={styles.logo} accessible={false} />
            {play ? (
              <View style={styles.eye}>
                <Animated.View style={[styles.pupil, {
                  opacity: track([4, 5, 6, 7], [1, 0, 1, 0]),
                  transform: [
                    { translateX: track([1, 2, 3, 4], [7, 5, 41, 23]) },
                    { translateY: track([1, 2, 3, 4], [21, 23, 18, 23]) },
                  ],
                }]} />
                <Animated.View style={[styles.lid, {
                  top: -46.5, transform: [{ translateY: track([4, 5, 6, 7], [0, 45, 0, 45]) }],
                }]} />
                <Animated.View style={[styles.lid, {
                  top: 89, transform: [{ translateY: track([4, 5, 6, 7], [0, -46.5, 0, -46.5]) }],
                }]} />
              </View>
            ) : <Image source={require('../assets/peek/splashEye.svg')} style={styles.eye} accessible={false} />}
          </Animated.View>
        </View>
      </Animated.View>
      {height > 0 && play ? (
        <>
          <Animated.View style={[styles.curtain, {
            height: upper, top: 0, transformOrigin: 'center bottom', opacity: curtainOpacity,
            transform: [
              { translateX: curtainCenter }, { translateY: upperTravel },
              { scaleX: curtainWidth }, { scaleY: track([7, 8], [2 / upper, 1]) },
            ],
          }]} />
          <Animated.View style={[styles.curtain, {
            height: lower, bottom: 0, transformOrigin: 'center top', opacity: curtainOpacity,
            transform: [
              { translateX: curtainCenter }, { translateY: lowerTravel },
              { scaleX: curtainWidth }, { scaleY: track([7, 8], [2 / lower, 1]) },
            ],
          }]} />
          <Animated.View style={[styles.curtainLine, {
            top: upper - 2, opacity: curtainOpacity,
            transform: [{ translateX: curtainCenter }, { translateY: upperTravel }, { scaleX: curtainWidth }],
          }]} />
          <Animated.View style={[styles.curtainLine, {
            top: upper, opacity: curtainOpacity,
            transform: [{ translateX: curtainCenter }, { translateY: lowerTravel }, { scaleX: curtainWidth }],
          }]} />
        </>
      ) : null}
    </View>
  );
}

export function RecordingDot() {
  const reduceMotion = useReduceMotion();
  const opacity = useAnimatedValue(1);
  useEffect(() => {
    if (reduceMotion !== false) return;
    const pulse = Animated.loop(Animated.sequence([
      Animated.delay(500),
      Animated.timing(opacity, { toValue: 0.25, duration: 450, easing: easeInOut, useNativeDriver: true, isInteraction: false }),
      Animated.delay(500),
      Animated.timing(opacity, { toValue: 1, duration: 450, easing: easeInOut, useNativeDriver: true, isInteraction: false }),
    ]));
    pulse.start();
    return () => { pulse.stop(); opacity.setValue(1); };
  }, [opacity, reduceMotion]);
  return <Animated.View style={[styles.recordingDot, { opacity }]} accessible={false} />;
}

export function ThinkingDots() {
  const reduceMotion = useReduceMotion();
  const phase = useAnimatedValue(0);
  useEffect(() => {
    if (reduceMotion !== false) return;
    const chase = Animated.loop(Animated.sequence([1, 2, 3].flatMap((next) => [
      Animated.delay(300),
      Animated.timing(phase, { toValue: next, duration: 200, easing: easeInOut, useNativeDriver: true, isInteraction: false }),
    ])));
    chase.start();
    return () => { chase.stop(); phase.setValue(0); };
  }, [phase, reduceMotion]);
  const output = [[1, 0.3, 0.3, 1], [0.3, 1, 0.3, 0.3], [0.3, 0.3, 1, 0.3]];
  return (
    <View style={styles.thinkingDots} accessible={false}>
      {output.map((outputRange, index) => (
        <Animated.View key={index} style={[styles.thinkingDot, { opacity: phase.interpolate({ inputRange: [0, 1, 2, 3], outputRange }) }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  splash: { ...StyleSheet.absoluteFill, zIndex: 5 },
  artBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  art: { width: 310, height: 199 },
  wordClip: { position: 'absolute', top: 72, left: 0, right: 0, height: 126, overflow: 'hidden' },
  wordMask: { width: 310, height: 126 },
  word: { color: colors.text, fontFamily: fonts.semibold, fontSize: 82 },
  logoGroup: { position: 'absolute', width: 211, height: 199, top: 0, left: 0 },
  logo: { width: 211, height: 199 },
  eye: { position: 'absolute', width: 87, height: 87, top: 33, left: 79, overflow: 'hidden', borderRadius: 43.5, backgroundColor: colors.white },
  pupil: { width: 42, height: 42, borderRadius: 21, backgroundColor: brandRed },
  lid: { position: 'absolute', left: 0, width: 87, height: 46.5, backgroundColor: brandRed },
  curtain: { position: 'absolute', left: 0, right: 0, backgroundColor: colors.background },
  curtainLine: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: brandRed },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  thinkingDots: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  thinkingDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.note },
});
