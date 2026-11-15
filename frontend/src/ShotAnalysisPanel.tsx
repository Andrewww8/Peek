import { useEffect, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { apiUrl } from './api';
import { accessToken } from './auth';
import type { PracticeStore } from './database';
import { getShotAnalysis, type ShotAnalysis } from './shot-analysis';
import { Button, Panel, ui } from './ui';

function summary(state: ReturnType<PracticeStore['sessionCloudShots']>[number]['state'], analysis?: ShotAnalysis) {
  switch (analysis?.status) {
    case 'complete': {
      if (!analysis.usable) return 'The pose was too unclear for reliable measurements.';
      const measurements = [];
      if (analysis.elbowAngleDeg !== null) measurements.push(`Elbow at release ${Math.round(analysis.elbowAngleDeg)}°`);
      if (analysis.kneeFlexionDeg !== null) measurements.push(`Knee at dip ${Math.round(analysis.kneeFlexionDeg)}°`);
      return measurements.join(' · ') || 'No form measurements available.';
    }
    case 'failed': return 'The shooter’s pose could not be measured.';
    case 'expired': return 'The clip expired before analysis.';
    case 'pending': return 'Waiting for analysis';
    default: return state === 'unavailable' ? 'Clip unavailable for analysis' : 'Waiting for sync';
  }
}

export function ShotAnalysisPanel({ store, sessionId, userId, shotCount }: {
  store: PracticeStore;
  sessionId: string;
  userId: string;
  shotCount: number;
}) {
  const [results, setResults] = useState(new Map<number, ShotAnalysis>());
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      if (signal.aborted) return;
      if (AppState.currentState === 'background') {
        timer = setTimeout(load, 15_000);
        return;
      }
      try {
        const shots = await getShotAnalysis(apiUrl, sessionId, (renew) => accessToken(userId, renew), signal);
        if (signal.aborted) return;
        setResults(shots);
        setError(false);
        if (store.sessionCloudShots(userId, sessionId).some(({ shotNumber, state }) =>
          state !== 'unavailable' && (shots.get(shotNumber)?.status ?? 'pending') === 'pending',
        )) timer = setTimeout(load, 15_000);
      } catch {
        if (!signal.aborted) setError(true);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }

    setLoading(true);
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [store, sessionId, userId, shotCount, refresh]);

  return (
    <Panel>
      <Text accessibilityRole="header" style={ui.title}>Shot analysis</Text>
      {error ? <Text accessibilityRole="alert" style={ui.body}>Couldn’t refresh shot analysis.</Text> : null}
      {store.sessionCloudShots(userId, sessionId).map(({ shotNumber, state }) => (
        <View key={shotNumber}>
          <Text style={ui.text}>Shot {shotNumber}</Text>
          <Text style={ui.body}>{summary(state, results.get(shotNumber))}</Text>
        </View>
      ))}
      <Button label={loading ? 'Checking analysis…' : 'Refresh analysis'} kind="secondary" disabled={loading} onPress={() => setRefresh((value) => value + 1)} />
    </Panel>
  );
}
